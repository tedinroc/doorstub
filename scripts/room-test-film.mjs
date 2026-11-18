#!/usr/bin/env node
// npm run room:test-film -- [--seconds 60] [--out .cache/room/testfilm]
//
// A test film for the screening room (ffmpeg): the testsrc2 pattern at
// 1920x1080, 30 fps, with a large burned-in timecode (HH:MM:SS.mmm of the
// film's own clock) and a 1 kHz beep for the first 0.1 s of every second, so
// sync and sound can be checked by eye and ear on two devices side by side.
// Writes <out>/testfilm-<seconds>s.mp4 and prints its path. Reuses the file
// when it is already there (--force makes it again).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '60' },
    out: { type: 'string', default: join(repoRoot, '.cache', 'room', 'testfilm') },
    force: { type: 'boolean', default: false },
  },
});

const seconds = Number(values.seconds);
if (!Number.isInteger(seconds) || seconds < 2 || seconds > 3_600) {
  console.error('room-test-film: --seconds must be a whole number from 2 to 3600');
  process.exit(1);
}
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const file = join(out, `testfilm-${seconds}s.mp4`);
if (existsSync(file) && !values.force) {
  console.log(file);
  process.exit(0);
}

// A system font when there is one; otherwise drawtext asks fontconfig for its default.
const font = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find((f) => existsSync(f));
const fontArg = font === undefined ? '' : `fontfile='${font}':`;
const timecode = `drawtext=${fontArg}text='%{pts\\:hms}':fontsize=200:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=28:x=(w-tw)/2:y=(h-th)/2`;
const label = `drawtext=${fontArg}text='DOORSTUB TEST FILM':fontsize=56:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=14:x=(w-tw)/2:y=h-th-80`;
const beep = `aevalsrc='if(lt(mod(t\\,1)\\,0.1)\\,0.4*sin(2*PI*1000*t)\\,0)':s=48000:d=${seconds}`;

const tmp = `${file}.part.mp4`;
rmSync(tmp, { force: true });
const args = [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
  '-f', 'lavfi', '-i', beep,
  '-vf', `${timecode},${label}`,
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
  '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
  '-movflags', '+faststart', '-t', String(seconds),
  tmp,
];
const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
if (r.error || r.status !== 0) {
  rmSync(tmp, { force: true });
  console.error(`room-test-film: ffmpeg failed: ${r.error?.message ?? (r.stderr ?? '').split('\n').filter((l) => !/^Fontconfig/.test(l)).slice(-10).join('\n')}`);
  process.exit(1);
}
renameSync(tmp, file);
console.log(file);
