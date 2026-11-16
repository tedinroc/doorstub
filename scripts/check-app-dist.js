#!/usr/bin/env node
// Checks the production build in app/dist (run by `npm run app:build`):
// - no test override path survived: the simnet resolver's words, the dev
//   panel, the E2E handle and local addresses are all absent;
// - the pinned production settings are present (our /shows.json, mainnet servers);
// - no local paths, other handles or e-mail addresses leaked into the bundle;
// - WizardConnect (LGPL) ships as its own file, and the CSP file is there;
// - the BLAZE banner's three values (app/src/config.js) are filled in and in
//   the bundle: an empty one fails the build unless DOORSTUB_ALLOW_PLACEHOLDERS=1.
// Exits non-zero with every problem listed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenWords } from './hygiene-words.js';
import { BLAZE } from '../app/src/config.js';

const dist = fileURLToPath(new URL('../app/dist', import.meta.url));
if (!existsSync(dist)) {
  console.error('app/dist does not exist; run `npm run app:build`');
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(dist);
const text = (path) => readFileSync(path, 'utf8');
const code = files.filter((f) => /\.(?:js|html|css|json|txt)$/.test(f) || f.endsWith('_headers'));
const all = code.map((f) => ({ file: relative(dist, f), body: text(f) }));

const problems = [];
const forbid = (needle, why) => {
  for (const { file, body } of all) {
    const hit = typeof needle === 'string' ? body.includes(needle) : needle.test(body);
    if (hit) problems.push(`${file}: contains ${needle} (${why})`);
  }
};

// Test-only paths (app/src/lib/runtime.js resolveTestRuntime, app/src/lib/dev.js, the E2E handle).
forbid('must be a local ws:// URL', 'the simnet runtime resolver');
forbid('must be a local http:// origin', 'the simnet runtime resolver');
forbid('shows must be a path', 'the simnet runtime resolver');
forbid('relay must be a local', 'the simnet runtime resolver');
forbid('pagekeeper', 'the E2E switch for the page keeper');
forbid('simnet.fund', 'the simnet dev helpers');
forbid('simnet.mine', 'the simnet dev helpers');
forbid('__doorstub', 'the E2E handle');
forbid('data-dev-fund', 'the dev panel');
forbid('__DOORSTUB_TEST_HOOKS__', 'the build flag must be replaced');
forbid(/\b127\.0\.0\.1\b/, 'a local address');
forbid(/localhost:\d/, 'a local address');
forbid(/\?fulcrum=|[?&]api=/, 'a URL override');
// Hygiene.
forbid(/\/Users\/|\/home\/[a-z]/, 'an absolute local path');
for (const word of forbiddenWords()) forbid(word.pattern, word.why);
forbid(/[A-Za-z0-9._%+-]+@(?!media|keyframes|font-face|supports|import|charset|layer|container|property|namespace|page)[A-Za-z0-9-]+\.(?:com|net|org|io|dev|cash|app)\b/, 'an e-mail address');

const need = (needle, why) => {
  if (!all.some(({ body }) => body.includes(needle))) problems.push(`no file contains ${needle} (${why})`);
};
need('/shows.json', 'the production show list');
need('wss://fulcrum.greyh.at:50004', 'the pinned mainnet servers');
need('wss://relay.riften.net', 'the pinned WizardConnect relays');
need('Tickets that refund themselves.', 'the headline');
need('Built from scratch during BCH BLAZE 2026; first commit 16 Nov (UTC); no earlier code.', 'the BLAZE banner line');

// The BLAZE banner: a presentation link, the source link and the EMBER2026 donation address.
const allowPlaceholders = process.env.DOORSTUB_ALLOW_PLACEHOLDERS === '1';
const blazeRules = {
  presentationUrl: [/^https:\/\/\S+$/, 'an https link to the short presentation'],
  sourceUrl: [/^https:\/\/github\.com\/tedinroc\/\S+$/, 'the public repository link'],
  donationAddress: [/^bitcoincash:z[0-9a-z]{41,}$/, 'a token-aware cashaddr (bitcoincash:z...)'],
};
const placeholders = [];
for (const [key, [rule, what]] of Object.entries(blazeRules)) {
  const value = BLAZE[key];
  if (value === '') {
    placeholders.push(key);
    if (!allowPlaceholders) problems.push(`BLAZE.${key} in app/src/config.js is empty: fill in ${what} (or set DOORSTUB_ALLOW_PLACEHOLDERS=1 for a preview build)`);
  } else {
    if (!rule.test(value)) problems.push(`BLAZE.${key} is not ${what}: ${value}`);
    need(value, `BLAZE.${key} in the banner`);
  }
}

const assets = readdirSync(join(dist, 'assets'));
if (!assets.some((f) => /^wizardconnect-.*\.js$/.test(f))) problems.push('WizardConnect (LGPL) is not in its own assets/wizardconnect-*.js file');
for (const f of ['_headers', 'shows.json', 'icon.png', 'bcmr/icon.png', 'favicon.svg', 'licenses.txt', 'fonts/barlow-condensed-800.woff2', 'fonts/OFL.txt', 'deck.pdf']) {
  if (!existsSync(join(dist, f))) problems.push(`app/dist/${f} is missing`);
}

const size = files.reduce((s, f) => s + statSync(f).size, 0);
if (problems.length > 0) {
  console.error(`app/dist check FAILED (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`app/dist check passed: ${files.length} files, ${(size / 1024).toFixed(0)} KiB; no test overrides, local addresses, paths, handles or e-mail addresses.`);
if (placeholders.length > 0) console.log(`  PLACEHOLDERS allowed (DOORSTUB_ALLOW_PLACEHOLDERS=1): BLAZE.${placeholders.join(', BLAZE.')} still empty; not for deployment.`);
