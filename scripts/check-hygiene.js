#!/usr/bin/env node
// npm run check:hygiene: every tracked file (and, with --history, every
// commit's added lines and every commit's author) must be free of absolute
// local paths, this machine's user name, other handles, e-mail addresses and
// co-author trailers. The public identity is tedinroc / Ted Chen only.
// The forbidden words come from scripts/hygiene-words.js (read at run time,
// never committed). Exits non-zero with every hit listed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forbiddenWords } from './hygiene-words.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const history = process.argv.includes('--history');

// GitHub's noreply address for tedinroc is the one address allowed (commit metadata only).
const EMAIL = /[A-Za-z0-9._%+-]+@(?!media\b|keyframes\b|font-face\b|supports\b|import\b|charset\b|layer\b|container\b|property\b|namespace\b|page\b)[A-Za-z0-9-]+\.(?:com|net|org|io|dev|cash|app|me|co)\b/g;
const rules = [
  ...forbiddenWords().map((w) => ({ pattern: w.pattern, why: w.why })),
  { pattern: /(?:^|[\s"'`(=])\/(?:Users|home)\/[A-Za-z]/m, why: 'an absolute local path' },
  // Spelled from parts so this file does not match itself.
  { pattern: new RegExp(['co', 'authored', 'by'].join('-'), 'i'), why: 'a co-author trailer' },
];
const SKIP = new Set(['package-lock.json']);

const problems = [];
const scan = (where, text) => {
  for (const rule of rules) if (rule.pattern.test(text)) problems.push(`${where}: ${rule.why}`);
  for (const m of text.matchAll(EMAIL)) {
    if (!/^[\w.-]+@example\.(?:org|com|net)$/.test(m[0])) problems.push(`${where}: an e-mail address`);
  }
};

const files = git('ls-files', '-z').split('\0').filter((f) => f !== '' && !SKIP.has(f));
for (const file of files) {
  let text;
  try {
    text = readFileSync(`${root}/${file}`, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue; // binary
  scan(file, text);
}

if (history) {
  for (const line of git('log', '--all', '--format=%h%x09%an%x09%ae%x09%B%x00').split('\0')) {
    const [hash, name, email, ...body] = line.trim().split('\t');
    if (hash === undefined || hash === '') continue;
    if (name !== 'Ted Chen' || !/^\d+\+tedinroc@users\.noreply\.github\.com$/.test(email)) problems.push(`commit ${hash}: author is not Ted Chen <tedinroc noreply>`);
    scan(`commit ${hash} message`, body.join('\t'));
  }
  const patches = git('log', '--all', '-p', '--no-color', '--format=%x00commit %h', '--', '.', ':!package-lock.json');
  for (const chunk of patches.split('\0commit ').slice(1)) {
    const hash = chunk.slice(0, chunk.indexOf('\n'));
    const added = chunk
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .join('\n');
    scan(`commit ${hash} (added lines)`, added);
  }
}

if (problems.length > 0) {
  console.error(`hygiene check FAILED (${problems.length}):\n  ${[...new Set(problems)].join('\n  ')}`);
  process.exit(1);
}
console.log(`hygiene check passed: ${files.length} tracked files${history ? ' and the whole history' : ''}; no local paths, other handles, e-mail addresses or co-author trailers.`);
