#!/usr/bin/env node
// node scripts/add-room-media.mjs [--from <dir>] [--key-file .secrets/room.json] [--dist app/dist]
//
// Copies the screening room's media (what scripts/room-media.mjs wrote:
// room.json, film.m3u8, preview.m3u8 and <version>/...) into
// <dist>/room/media/<folder>/, after `npm run app:build` (which empties
// app/dist). <folder> is derived from ROOM_KEY (worker/lib/room.js
// roomMediaFolder), read from the key file in this process and never
// printed, so the folder always matches the key the door signs with.
//
// The media is gated before and after the copy (scripts/room-media-gate.mjs):
// files under 25 MiB, only m3u8/m4s/mp4/json, relative playlists with no byte
// ranges, nothing local or private in the playlists, room.json or the init
// segments, and a film. `npm run deploy:prep` runs app:build, this, then
// `check-app-dist.js --expect-room-media`.
//
//   --from      default: $ROOM_MEDIA_DIR, else ../doorstub-film/picture/build/hls
//   --key-file  default: .secrets/room.json ({ "ROOM_KEY": "<64 hex>" }); tests pass a test key
//   --dist      default: app/dist
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { roomMediaFolder } from '../worker/lib/room.js';
import { gateRoomMedia } from './room-media-gate.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    'key-file': { type: 'string', default: join(repoRoot, '.secrets', 'room.json') },
    dist: { type: 'string', default: join(repoRoot, 'app', 'dist') },
  },
});

const fail = (message) => {
  console.error(`add-room-media: ${message}`);
  process.exit(1);
};

const from = resolve(values.from ?? process.env.ROOM_MEDIA_DIR ?? join(repoRoot, '..', 'doorstub-film', 'picture', 'build', 'hls'));
const dist = resolve(values.dist);
if (!existsSync(join(dist, 'room', 'index.html'))) fail(`${values.dist} has no room/index.html; run \`npm run app:build\` first`);
if (!existsSync(from)) fail(`no media folder at --from (${values.from ?? 'the default'}); encode one with \`npm run room:media\``);

// The key stays in this process: read, checked, used, never printed or written anywhere else.
let folder;
{
  let key;
  try {
    const body = JSON.parse(readFileSync(values['key-file'], 'utf8'));
    key = body?.ROOM_KEY ?? body?.roomKey;
  } catch {
    fail(`could not read ROOM_KEY from the key file (${values['key-file'] === join(repoRoot, '.secrets', 'room.json') ? '.secrets/room.json' : 'the --key-file'})`);
  }
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/i.test(key.trim())) fail('the key file has no ROOM_KEY of 64 hex characters');
  folder = roomMediaFolder(key.trim().toLowerCase());
}
if (!/^[0-9a-f]{32}$/.test(folder)) fail('roomMediaFolder did not give 32 hex');

const before = gateRoomMedia(from, { skipDot: true });
if (before.problems.length > 0) fail(`the media in --from failed the gate (${before.problems.length}):\n  ${before.problems.join('\n  ')}`);

// One folder only: an older key's folder or an older copy never ships next to this one.
const mediaRoot = join(dist, 'room', 'media');
rmSync(mediaRoot, { recursive: true, force: true });
mkdirSync(mediaRoot, { recursive: true });
const dest = join(mediaRoot, folder);
// Dot files and folders (an encoder's work folder, .DS_Store) are never copied.
cpSync(from, dest, { recursive: true, filter: (src) => !src.slice(from.length).split(/[\\/]/).some((part) => part.startsWith('.')) });

const after = gateRoomMedia(dest);
if (after.problems.length > 0) {
  rmSync(mediaRoot, { recursive: true, force: true });
  fail(`the copied media failed the gate, so it was removed again (${after.problems.length}):\n  ${after.problems.join('\n  ')}`);
}
if (readdirSync(mediaRoot).length !== 1) fail('room/media must hold exactly one folder');
const parts = ['film', 'preview'].filter((n) => after.room?.[n] != null).map((n) => `${n} ${after.room[n].seconds} s (${after.room[n].version})`);
console.log(`add-room-media: ${after.files} files, ${(after.bytes / 1048576).toFixed(1)} MiB into ${values.dist === join(repoRoot, 'app', 'dist') ? 'app/dist' : values.dist}/room/media/<folder from ROOM_KEY>/; ${parts.join(', ')}; gate passed`);
