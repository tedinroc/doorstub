// Words that must never appear in a committed file or a build: this
// machine's home folder and user name (read at run time, so they are never
// written down here), plus any extra handles listed one per line in the
// gitignored .secrets/hygiene-words.txt. The public identity is tedinroc /
// Ted Chen only.
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALLOWED = new Set(['tedinroc', 'ted', 'ted chen']);

/** [{ word, pattern, why }] */
export const forbiddenWords = () => {
  const out = [];
  const add = (word, why) => {
    const w = String(word ?? '').trim();
    if (w.length < 3 || ALLOWED.has(w.toLowerCase()) || out.some((o) => o.word.toLowerCase() === w.toLowerCase())) return;
    out.push({ word: w, pattern: new RegExp(escape(w), 'i'), why });
  };
  add(homedir(), "this machine's home folder");
  try {
    add(userInfo().username, "this machine's user name");
  } catch {
    // no user info (some containers)
  }
  const file = fileURLToPath(new URL('../.secrets/hygiene-words.txt', import.meta.url));
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.trim() !== '' && !line.trim().startsWith('#')) add(line, 'a handle other than tedinroc');
    }
  }
  return out;
};
