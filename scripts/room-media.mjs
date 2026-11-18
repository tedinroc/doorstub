#!/usr/bin/env node
// npm run room:media -- <master.mp4> <outdir> --name film|preview [--preset slow] [--force]
//
// Encodes one film for the screening room as fMP4 HLS VOD (ffmpeg):
// - 4 s segments, never single_file or byte ranges (Pages serves no ranges);
// - two renditions: 1080p (CRF 20, maxrate 4.5M, bufsize 9M) and 540p
//   (CRF 20, maxrate 1.2M, bufsize 2.4M), each with its AAC 128k audio;
// - every metadata field and chapter stripped, bitexact muxing;
// - relative URIs only.
// Writes
//   <outdir>/<version>/<name>/<1080p|540p>/{index.m3u8, init_*.mp4, seg-*.m4s}
//   <outdir>/<name>.m3u8     the master playlist (served no-cache), pointing into <version>/
//   <outdir>/room.json       { film: { seconds, version } | null, preview: { seconds, version } | null }
// <version> is a hash of the input file and these settings, so a re-encode of
// another cut lands in a new folder and a browser never mixes two cuts. Older
// versions of the same name are removed. The media lives outside git (the
// film's own repo keeps it under picture/build/hls/); scripts/add-room-media.mjs
// copies it into the build.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gateRoomMedia, playlistSeconds } from './room-media-gate.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    preset: { type: 'string', default: 'slow' },
    force: { type: 'boolean', default: false },
  },
});

const fail = (message) => {
  console.error(`room-media: ${message}`);
  process.exit(1);
};

const [input, outArg] = positionals;
if (input === undefined || outArg === undefined) fail('usage: room-media.mjs <master.mp4> <outdir> --name film|preview [--preset slow] [--force]');
const name = values.name;
if (!['film', 'preview'].includes(name)) fail('--name must be film or preview');
if (!/^(?:ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow)$/.test(values.preset)) fail('--preset must be an x264 preset');
if (!existsSync(input)) fail(`no such file: ${input}`);
const outdir = resolve(outArg);

const RENDITIONS = [
  { label: '1080p', height: 1080, crf: 20, maxrate: '4500k', bufsize: '9000k' },
  { label: '540p', height: 540, crf: 20, maxrate: '1200k', bufsize: '2400k' },
];
const SEGMENT_SECONDS = 4;
const AUDIO = { codec: 'aac', bitrate: '128k', channels: 2, rate: 48_000 };

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${cmd} did not run: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} failed (${r.status}):\n${(r.stderr ?? '').split('\n').slice(-15).join('\n')}`);
  return r.stdout;
};

// ------------------------------------------------------------------ what the input is

const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input]));
const videoStream = probe.streams.find((s) => s.codec_type === 'video');
const hasAudio = probe.streams.some((s) => s.codec_type === 'audio');
if (videoStream === undefined) fail('the input has no video stream');
const [num, den] = String(videoStream.avg_frame_rate || videoStream.r_frame_rate || '30/1').split('/').map(Number);
const fps = den > 0 && num > 0 ? num / den : 30;
const gop = Math.max(1, Math.round(fps * SEGMENT_SECONDS));
const ffmpegVersion = run('ffmpeg', ['-hide_banner', '-version']).split('\n')[0];

const settings = { RENDITIONS, SEGMENT_SECONDS, AUDIO, preset: values.preset, gop, hasAudio, ffmpegVersion, layout: 1 };
const hash = createHash('sha256');
await new Promise((ok, bad) => {
  createReadStream(input)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', ok)
    .on('error', bad);
});
hash.update(JSON.stringify(settings));
const version = hash.digest('hex').slice(0, 12);

mkdirSync(outdir, { recursive: true });
const finalDir = join(outdir, version, name);
const complete = (r) => {
  const path = join(finalDir, r.label, 'index.m3u8');
  return existsSync(path) && readFileSync(path, 'utf8').includes('#EXT-X-ENDLIST');
};
const done = RENDITIONS.every(complete);

// ------------------------------------------------------------------ encode

if (done && !values.force) {
  console.log(`room-media: ${name} ${version} is already encoded; reusing it (--force to encode again)`);
} else {
  const work = join(outdir, `.work-${name}-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, name), { recursive: true });
  const split = RENDITIONS.map((_, i) => `[s${i}]`).join('');
  const scales = RENDITIONS.map((r, i) => `[s${i}]scale=-2:${r.height}:flags=lanczos,format=yuv420p[v${i}]`).join(';');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact');
  args.push('-filter_complex', `[0:v]split=${RENDITIONS.length}${split};${scales}`);
  for (let i = 0; i < RENDITIONS.length; i += 1) args.push('-map', `[v${i}]`);
  if (hasAudio) for (let i = 0; i < RENDITIONS.length; i += 1) args.push('-map', '0:a:0');
  args.push('-c:v', 'libx264', '-preset', values.preset, '-profile:v', 'high', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
  args.push('-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`);
  RENDITIONS.forEach((r, i) => args.push(`-crf:v:${i}`, String(r.crf), `-maxrate:v:${i}`, r.maxrate, `-bufsize:v:${i}`, r.bufsize));
  if (hasAudio) args.push('-c:a', AUDIO.codec, '-b:a', AUDIO.bitrate, '-ac', String(AUDIO.channels), '-ar', String(AUDIO.rate));
  args.push('-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments');
  args.push('-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(work, name, '%v', 'seg-%03d.m4s'));
  args.push('-var_stream_map', RENDITIONS.map((r, i) => `v:${i}${hasAudio ? `,a:${i}` : ''},name:${r.label}`).join(' '));
  args.push(join(work, name, '%v', 'index.m3u8'));
  console.log(`room-media: encoding ${name} (${RENDITIONS.map((r) => r.label).join(' + ')}, preset ${values.preset}${hasAudio ? '' : ', no audio'}) into version ${version}`);
  run('ffmpeg', args);
  for (const r of RENDITIONS) if (!existsSync(join(work, name, r.label, 'index.m3u8'))) fail(`ffmpeg wrote no ${r.label} playlist`);
  rmSync(finalDir, { recursive: true, force: true });
  mkdirSync(join(outdir, version), { recursive: true });
  renameSync(join(work, name), finalDir);
  rmSync(work, { recursive: true, force: true });
}

// ------------------------------------------------------------------ master playlist and room.json

/** The H.264 codec string from the init segment's avcC box: avc1.<profile><constraints><level>. */
const avcCodec = (init) => {
  const at = init.indexOf(Buffer.from('avcC'));
  if (at < 0 || init[at + 4] !== 1) fail('no avcC box in an init segment');
  return `avc1.${[init[at + 5], init[at + 6], init[at + 7]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
for (const r of RENDITIONS) {
  const dir = join(finalDir, r.label);
  const playlist = readFileSync(join(dir, 'index.m3u8'), 'utf8');
  const initName = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1];
  if (initName === undefined) fail(`${r.label}: no EXT-X-MAP`);
  const initPath = join(dir, initName);
  const size = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', initPath])).streams[0];
  // BANDWIDTH is the peak segment bit rate; AVERAGE-BANDWIDTH the whole rendition's.
  const segs = [...playlist.matchAll(/#EXTINF:([0-9.]+),?\s*\n([^#\s][^\n]*)/g)].map((m) => ({ seconds: Number(m[1]), bytes: statSync(join(dir, m[2].trim())).size }));
  if (segs.length === 0) fail(`${r.label}: no segments`);
  const peak = Math.max(...segs.map((x) => (x.bytes * 8) / Math.max(x.seconds, 1)));
  const average = (segs.reduce((t, x) => t + x.bytes, 0) * 8) / segs.reduce((t, x) => t + x.seconds, 0);
  const codecs = [avcCodec(readFileSync(initPath)), ...(hasAudio ? ['mp4a.40.2'] : [])].join(',');
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(peak)},AVERAGE-BANDWIDTH=${Math.ceil(average)},RESOLUTION=${size.width}x${size.height},CODECS="${codecs}"`, `${version}/${name}/${r.label}/index.m3u8`);
}
writeFileSync(join(outdir, `${name}.m3u8`), `${lines.join('\n')}\n`);

const seconds = Math.round(playlistSeconds(readFileSync(join(finalDir, RENDITIONS[0].label, 'index.m3u8'), 'utf8')) * 1000) / 1000;
const roomPath = join(outdir, 'room.json');
let room = { film: null, preview: null };
if (existsSync(roomPath)) {
  try {
    const old = JSON.parse(readFileSync(roomPath, 'utf8'));
    room = { film: old.film ?? null, preview: old.preview ?? null };
  } catch {
    // rewritten below
  }
}
room[name] = { seconds, version };
writeFileSync(roomPath, `${JSON.stringify(room)}\n`);

// Older versions of this name are dropped, so the upload holds only what the masters point to.
for (const dir of readdirSync(outdir)) {
  if (!/^[0-9a-f]{12}$/.test(dir) || dir === version) continue;
  const old = join(outdir, dir, name);
  if (existsSync(old)) {
    rmSync(old, { recursive: true, force: true });
    console.log(`room-media: removed the older ${name} version ${dir}`);
  }
  if (readdirSync(join(outdir, dir)).length === 0) rmSync(join(outdir, dir), { recursive: true, force: true });
}

const gate = gateRoomMedia(outdir, { requireFilm: false, skipDot: true });
if (gate.problems.length > 0) fail(`the media gate FAILED (${gate.problems.length}):\n  ${gate.problems.join('\n  ')}`);
console.log(`room-media: ${name} ${version}, ${seconds} s; ${gate.files} files, ${(gate.bytes / 1048576).toFixed(1)} MiB in ${outArg}; gate passed`);
