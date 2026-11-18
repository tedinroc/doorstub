#!/usr/bin/env node
// Checks the production build in app/dist (run by `npm run app:build`):
// - no test override path survived: the simnet resolver's words, the dev
//   panel, the E2E handle and local addresses are all absent;
// - the pinned production settings are present (our /shows.json, mainnet servers);
// - no local paths, other handles or e-mail addresses leaked into the bundle;
// - WizardConnect (LGPL) ships as its own file, and the CSP file is there;
// - the screening room (room/index.html) is built: its script graph never
//   loads libauth, WizardConnect, the shared vendor chunk or any chain code,
//   never touches localStorage, and loads hls.js; the site's graph never loads
//   hls.js; licenses.txt carries hls.js and the Apache License 2.0;
// - with --expect-room-media (npm run deploy:prep): exactly one media folder
//   under room/media/, and it passes scripts/room-media-gate.mjs;
// - the BLAZE banner's three values (app/src/config.js) are filled in and in
//   the bundle: an empty one fails the build unless DOORSTUB_ALLOW_PLACEHOLDERS=1.
// Exits non-zero with every problem listed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenWords } from './hygiene-words.js';
import { gateRoomMedia } from './room-media-gate.mjs';
import { BLAZE } from '../app/src/config.js';

const expectRoomMedia = process.argv.includes('--expect-room-media');

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
for (const f of ['_headers', 'shows.json', 'icon.png', 'bcmr/icon.png', 'favicon.svg', 'licenses.txt', 'fonts/barlow-condensed-800.woff2', 'fonts/OFL.txt', 'deck.pdf', 'room/index.html']) {
  if (!existsSync(join(dist, f))) problems.push(`app/dist/${f} is missing`);
}

// The two pages' script graphs: every assets/*.js (or .css) a page or a chunk names, statically,
// dynamically or in Vite's preload list.
const graphOf = (htmlFile) => {
  const seen = new Set();
  const refs = (body) => [...body.matchAll(/(?:\/assets\/|\.\/)([\w.-]+\.(?:js|css))/g)].map((m) => m[1]).filter((name) => assets.includes(name));
  const queue = existsSync(htmlFile) ? refs(text(htmlFile)) : [];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.endsWith('.js')) queue.push(...refs(text(join(dist, 'assets', name))));
  }
  return [...seen];
};
const siteGraph = graphOf(join(dist, 'index.html'));
const roomGraph = graphOf(join(dist, 'room', 'index.html'));
if (!assets.some((f) => /^hls-.*\.js$/.test(f))) problems.push('hls.js is not in its own assets/hls-*.js file');
for (const name of siteGraph) if (/^hls-/.test(name)) problems.push(`the site (index.html) loads ${name}: hls.js belongs to the room only`);
if (!roomGraph.some((n) => /^room-.*\.js$/.test(n))) problems.push('room/index.html does not load its assets/room-*.js entry');
if (!roomGraph.some((n) => /^hls-.*\.js$/.test(n))) problems.push('the room does not load hls.js');
for (const name of roomGraph) {
  if (/^(?:libauth|wizardconnect|vendor|index)-/.test(name)) problems.push(`the room loads ${name}: it must not load the wallet, chain or site code`);
  if (!name.endsWith('.js')) continue;
  const body = text(join(dist, 'assets', name));
  if (/localStorage/.test(body)) problems.push(`${name} (room) touches localStorage`);
  if (/wss:\/\/|blockchain\.(?:scripthash|transaction|headers)/.test(body)) problems.push(`${name} (room) carries chain-server code`);
}
const roomHtml = existsSync(join(dist, 'room', 'index.html')) ? text(join(dist, 'room', 'index.html')) : '';
if (!/<meta name="robots" content="noindex"/.test(roomHtml)) problems.push('room/index.html has no robots noindex meta');
const licences = existsSync(join(dist, 'licenses.txt')) ? text(join(dist, 'licenses.txt')) : '';
if (!licences.includes('hls.js') || !licences.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')) problems.push('licenses.txt must name hls.js and carry the Apache License 2.0 text');

// npm run deploy:prep: the film is in, under the one folder derived from ROOM_KEY (scripts/add-room-media.mjs).
let mediaLine = '';
if (expectRoomMedia) {
  const mediaRoot = join(dist, 'room', 'media');
  const folders = existsSync(mediaRoot) ? readdirSync(mediaRoot) : [];
  if (folders.length !== 1 || !/^[0-9a-f]{32}$/.test(folders[0])) problems.push('room/media/ must hold exactly one 32-hex folder (run scripts/add-room-media.mjs)');
  else {
    const gate = gateRoomMedia(join(mediaRoot, folders[0]));
    for (const p of gate.problems) problems.push(`room media: ${p}`);
    mediaLine = `; room media: ${gate.files} files, film ${gate.room?.film?.seconds ?? '-'} s${gate.room?.preview ? `, preview ${gate.room.preview.seconds} s` : ''}`;
  }
}

const size = files.reduce((s, f) => s + statSync(f).size, 0);
if (problems.length > 0) {
  console.error(`app/dist check FAILED (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`app/dist check passed: ${files.length} files, ${(size / 1024).toFixed(0)} KiB; no test overrides, local addresses, paths, handles or e-mail addresses; the room loads no wallet or chain code${mediaLine}.`);
if (placeholders.length > 0) console.log(`  PLACEHOLDERS allowed (DOORSTUB_ALLOW_PLACEHOLDERS=1): BLAZE.${placeholders.join(', BLAZE.')} still empty; not for deployment.`);
