// The gate for the screening room's media folder (what scripts/room-media.mjs
// writes and scripts/add-room-media.mjs copies into app/dist/room/media/<folder>/).
// Used by add-room-media and by `check-app-dist.js --expect-room-media`.
//
// Fails on:
// - a file of 25 MiB or more (the Cloudflare Pages limit per file);
// - an extension other than m3u8, m4s, mp4 or json;
// - a playlist with EXT-X-BYTERANGE, "http", an absolute path, or a URI that
//   is not relative or names a missing file;
// - a forbidden word (scripts/hygiene-words.js), a local path or an e-mail
//   address in a playlist, room.json or the printable strings of an init segment;
// - a room.json that is not { film: { seconds, version } | null, preview: ... },
//   a missing film (unless allowed), or a master playlist that does not point
//   into its version, or whose length differs from room.json.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { forbiddenWords } from './hygiene-words.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MEDIA_EXTENSIONS = Object.freeze(['.m3u8', '.m4s', '.mp4', '.json']);
const LOCAL_PATH = /\/Users\/|\/home\/[a-z]|[A-Za-z]:\\/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(?:com|net|org|io|dev|cash|app)\b/;

const walk = (dir, skipDot, out = []) => {
  for (const name of readdirSync(dir)) {
    if (skipDot && name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, skipDot, out);
    else out.push(path);
  }
  return out;
};

/** Printable ASCII runs of at least `min` characters, as `strings` prints them. */
export const printableStrings = (bytes, min = 4) => {
  const out = [];
  let run = '';
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) run += String.fromCharCode(b);
    else {
      if (run.length >= min) out.push(run);
      run = '';
    }
  }
  if (run.length >= min) out.push(run);
  return out;
};

/** Lines of a playlist that are URIs: plain lines, and URI="…" attributes (EXT-X-MAP). */
export const playlistUris = (text) => {
  const uris = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    if (t.startsWith('#')) {
      for (const m of t.matchAll(/URI="([^"]*)"/g)) uris.push(m[1]);
    } else uris.push(t);
  }
  return uris;
};

/** Sum of a media playlist's #EXTINF durations, in seconds. */
export const playlistSeconds = (text) => [...text.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);

const shapeOk = (m) => m === null || (m !== null && typeof m === 'object' && Number.isFinite(m.seconds) && m.seconds > 0 && typeof m.version === 'string' && /^[0-9a-z-]{1,40}$/.test(m.version) && Object.keys(m).every((k) => ['seconds', 'version'].includes(k)));

/**
 * @param {string} dir the media folder (holds room.json, film.m3u8, preview.m3u8 and <version>/...)
 * @param {{ requireFilm?: boolean, skipDot?: boolean, words?: Array<{ pattern: RegExp, why: string }> }} [options]
 *   skipDot: leave out dot files and folders (an encoder's work folder) in a source folder; a
 *   folder that will be deployed is checked with them, so one fails the gate.
 * @returns {{ problems: string[], files: number, bytes: number, room: object|null }}
 */
export const gateRoomMedia = (folder, { requireFilm = true, skipDot = false, words = forbiddenWords() } = {}) => {
  const dir = resolve(folder);
  const problems = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { problems: [`${dir} is not a folder`], files: 0, bytes: 0, room: null };
  const files = walk(dir, skipDot);
  let bytes = 0;
  const scan = (where, text) => {
    if (LOCAL_PATH.test(text)) problems.push(`${where}: contains a local path`);
    if (EMAIL.test(text)) problems.push(`${where}: contains an e-mail address`);
    for (const w of words) if (w.pattern.test(text)) problems.push(`${where}: contains a forbidden word (${w.why})`);
  };
  for (const file of files) {
    const rel = relative(dir, file);
    const size = statSync(file).size;
    bytes += size;
    if (size >= MAX_FILE_BYTES) problems.push(`${rel}: ${(size / 1048576).toFixed(1)} MiB, the limit is under 25 MiB`);
    const ext = extname(file).toLowerCase();
    if (!MEDIA_EXTENSIONS.includes(ext)) {
      problems.push(`${rel}: extension ${ext || '(none)'} is not one of ${MEDIA_EXTENSIONS.join(', ')}`);
      continue;
    }
    if (ext === '.m3u8') {
      const text = readFileSync(file, 'utf8');
      if (!text.startsWith('#EXTM3U')) problems.push(`${rel}: not an HLS playlist`);
      if (/EXT-X-BYTERANGE/i.test(text)) problems.push(`${rel}: uses EXT-X-BYTERANGE (Pages does not serve ranges)`);
      if (/http/i.test(text)) problems.push(`${rel}: contains "http"; URIs must be relative`);
      scan(rel, text);
      for (const uri of playlistUris(text)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/') || uri.includes('\\')) {
          problems.push(`${rel}: URI ${uri} is not relative`);
          continue;
        }
        const target = normalize(join(dirname(file), uri));
        if (!target.startsWith(dir.endsWith(sep) ? dir : dir + sep)) problems.push(`${rel}: URI ${uri} leaves the media folder`);
        else if (!existsSync(target)) problems.push(`${rel}: URI ${uri} names a missing file`);
      }
    } else if (ext === '.json') {
      scan(rel, readFileSync(file, 'utf8'));
    } else if (ext === '.mp4') {
      scan(`${rel} (strings)`, printableStrings(readFileSync(file)).join('\n'));
    }
  }

  let room = null;
  const roomPath = join(dir, 'room.json');
  if (!existsSync(roomPath)) problems.push('room.json is missing');
  else {
    try {
      room = JSON.parse(readFileSync(roomPath, 'utf8'));
    } catch {
      problems.push('room.json is not JSON');
    }
  }
  if (room !== null) {
    if (typeof room !== 'object' || Array.isArray(room) || !shapeOk(room.film ?? null) || !shapeOk(room.preview ?? null) || Object.keys(room).some((k) => !['film', 'preview'].includes(k))) {
      problems.push('room.json must be { "film": { "seconds", "version" } | null, "preview": { "seconds", "version" } | null }');
    } else {
      if (requireFilm && room.film == null) problems.push('room.json has no film');
      for (const name of ['film', 'preview']) {
        const m = room[name] ?? null;
        const master = join(dir, `${name}.m3u8`);
        if (m === null) {
          if (existsSync(master)) problems.push(`${name}.m3u8 exists but room.json has no ${name}`);
          continue;
        }
        if (!existsSync(master)) {
          problems.push(`${name}.m3u8 is missing`);
          continue;
        }
        const variants = playlistUris(readFileSync(master, 'utf8'));
        if (variants.length === 0) problems.push(`${name}.m3u8 lists no rendition`);
        for (const v of variants) {
          if (!v.startsWith(`${m.version}/${name}/`)) problems.push(`${name}.m3u8: ${v} is not under ${m.version}/${name}/ (room.json's version)`);
          const path = join(dir, v);
          if (!existsSync(path)) continue;
          const seconds = playlistSeconds(readFileSync(path, 'utf8'));
          if (Math.abs(seconds - m.seconds) > 1) problems.push(`${v}: ${seconds.toFixed(1)} s, room.json says ${m.seconds} s`);
        }
      }
    }
  }
  if (files.length > 15_000) problems.push(`${files.length} files: too many for one Pages deployment`);
  return { problems, files: files.length, bytes, room };
};
