/**
 * `sfa-view`: lets the model look at files in the agent's container. It
 * turns images, video, PDFs and screenshots into images that go back to the
 * model with the shell call's result (the only command whose result carries
 * images). The work runs in the container with ffmpeg, ImageMagick and
 * poppler from the image; SF Agents only receives the finished images (and,
 * for `transcript`, audio to put through its speech-to-text model).
 */

import type { ToolImage } from './tools.js';

export const VIEW_COMMAND = 'sfa-view';

/** Images one shell call may show the model, unless limits.viewImages says otherwise. */
export const DEFAULT_VIEW_IMAGES = 8;
export const MAX_VIEW_IMAGES = 20;
/** Largest image SF Agents accepts from the container. */
export const MAX_VIEW_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const VIEW_USAGE = [
  'Usage (each image costs about 1,000 to 1,600 tokens; one shell call shows at most the agent\'s limit, 8 by default):',
  '  sfa-view image <files...> [--max-side 1568]   images as they are, downscaled to fit',
  '  sfa-view info <video>                         duration, resolution, fps, audio tracks, scene changes (text only)',
  '  sfa-view sheet <video> [--every 2s | --count 16] [--from 0:30 --to 1:10] [--grid 4x4] [--scenes]',
  '                                                contact sheets: frames tiled with their timestamps',
  '  sfa-view frames <video> --at 0:12.5,0:13      single frames at full detail',
  '  sfa-view crop <image | video@0:12> <x,y,w,h> [--zoom 2]   a region, enlarged',
  '  sfa-view diff <a> <b>                         side by side, plus the changed pixels highlighted',
  '  sfa-view transcript <video or audio> [--from 0:30 --to 2:00]   speech to text with timestamps (text only)',
  '  sfa-view pdf <file> --pages 1-3 [--dpi 110]   PDF pages as images',
  'For a video: info first, then one or two sheets, then frames or crop on the moments that matter, and transcript when speech matters.',
].join('\n');

/** What `sfa-view` may do for one agent. */
export interface ViewGrant {
  /** Images per shell call. */
  maxImages: number;
  /** Speech to text with SF Agents' own model (a WAV file in, text out); absent when it is not available. */
  transcribe?: (wav: Buffer, signal: AbortSignal) => Promise<string>;
}

export type ViewReply = { ok: true; text: string } | { ok: false; error: string };

/**
 * The host half of `sfa-view` (the container script asks with these):
 * `--limit` (how many images it may still send), `--attach` (stdin: JSON
 * list of {mime, data (base64), label}), `--transcribe <seconds>` (stdin: a
 * base64 WAV that starts at that time).
 */
export async function runViewCommand(grant: ViewGrant, args: readonly string[], o: { stdin?: string; images?: ToolImage[]; signal: AbortSignal }): Promise<ViewReply> {
  const [op, arg] = args;
  const images = o.images;
  if (op === '--limit') return { ok: true, text: String(images ? Math.max(0, grant.maxImages - images.length) : 0) };
  if (op === '--attach') {
    if (!images) return { ok: false, error: 'Images can be shown only from a command that runs in the foreground (not background: true).' };
    let list: Array<{ mime?: unknown; data?: unknown; label?: unknown }>;
    try {
      list = JSON.parse(o.stdin ?? '[]') as typeof list;
      if (!Array.isArray(list)) throw new Error('not a list');
    } catch {
      return { ok: false, error: 'Malformed images.' };
    }
    if (images.length + list.length > grant.maxImages) {
      return {
        ok: false,
        error: `That is ${list.length} images, and this call may show ${grant.maxImages - images.length} more (limit ${grant.maxImages} per shell call, limits.viewImages). Narrow --from/--to, use fewer sheet frames or a bigger --grid, or split the work across calls.`,
      };
    }
    const added: ToolImage[] = [];
    for (const item of list) {
      if (typeof item.mime !== 'string' || !IMAGE_TYPES.has(item.mime) || typeof item.data !== 'string') return { ok: false, error: 'Only PNG, JPEG, GIF and WebP images can be shown.' };
      const data = Buffer.from(item.data, 'base64');
      if (data.length > MAX_VIEW_IMAGE_BYTES) return { ok: false, error: 'An image is larger than 5 MB; use a smaller --max-side.' };
      added.push({ mime: item.mime, data, ...(typeof item.label === 'string' && item.label ? { label: item.label.slice(0, 200) } : {}) });
    }
    images.push(...added);
    return { ok: true, text: `${added.length}` };
  }
  if (op === '--transcribe') {
    if (!grant.transcribe) return { ok: false, error: 'Speech to text is not available in SF Agents (set it up in Settings → Speech).' };
    const wav = Buffer.from(o.stdin ?? '', 'base64');
    if (wav.length < 44) return { ok: false, error: 'No audio.' };
    void arg;
    return { ok: true, text: (await grant.transcribe(wav, o.signal)).trim() };
  }
  return { ok: false, error: 'sfa-view runs in your container; run it from the shell.' };
}

/** The container half: /run/sfa/bin/sfa-view (Node.js, CommonJS). */
export const VIEW_SOURCE = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { request } = require('/run/sfa/bin/sfa-client.cjs');

const USAGE = ${'$'}USAGE;
const TILE_MAX = 1568;

function die(message) {
  process.stderr.write('sfa-view: ' + message + '\n');
  process.exit(1);
}
function run(cmd, args, okCodes) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) die(cmd + ': ' + r.error.message);
  if (r.status !== 0 && !(okCodes || []).includes(r.status)) die(cmd + ' failed: ' + String(r.stderr || '').trim().split('\n').slice(-3).join(' '));
  return r;
}
function parseTime(text) {
  const t = String(text).trim().replace(/s$/, '');
  const parts = t.split(':').map(Number);
  if (!t || parts.some((p) => !Number.isFinite(p) || p < 0)) die('Not a time: ' + text + ' (use 75, 1:15 or 1:15.5)');
  return parts.reduce((a, p) => a * 60 + p, 0);
}
function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const ss = (s < 10 ? '0' : '') + (Math.round(s * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + ss;
}
function parse(args, valued) {
  const pos = [];
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (valued.includes(key)) {
        if (i + 1 >= args.length) die('--' + key + ' needs a value');
        o[key] = args[++i];
      } else o[key] = true;
    } else pos.push(a);
  }
  return { pos, o };
}
function need(file) {
  if (!file) die('Missing file.\n' + USAGE);
  if (!fs.existsSync(file)) die('No such file: ' + file);
  return file;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfa-view-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const out = (ext) => path.join(tmp, 'v' + n++ + '.' + ext);

function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  try { return JSON.parse(r.stdout); } catch { die('Cannot read ' + file); }
}
function duration(file) {
  const p = probe(file);
  const d = Number(p.format && p.format.duration);
  if (!Number.isFinite(d) || d <= 0) die(file + ' has no duration (is it a video?)');
  return d;
}
/** A copy that fits in max x max, as JPEG (photos, frames) or PNG (screenshots, diagrams). */
function fit(file, max, ext) {
  const target = out(ext || (/\.jpe?g$/i.test(file) ? 'jpg' : 'png'));
  run('convert', [file + '[0]', '-auto-orient', '-resize', max + 'x' + max + '>', '-quality', '82', target]);
  return target;
}
function frame(video, t, width) {
  const target = out('png');
  run('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-vf', 'scale=' + (width > 0 ? width : 'iw') + ':-2', target]);
  if (!fs.existsSync(target)) die('No frame at ' + fmt(t) + ' (past the end?)');
  return target;
}
function stamp(file, text) {
  run('convert', [file, '-gravity', 'SouthEast', '-pointsize', '18', '-fill', 'white', '-undercolor', '#000000B0', '-annotate', '+3+3', ' ' + text + ' ', file]);
  return file;
}
async function limit() {
  const r = await request(['sfa-view', '--limit']);
  if (!r.ok) die(r.error);
  return Number(r.text);
}
async function show(list, note) {
  const left = await limit();
  if (list.length > left) die('That is ' + list.length + ' images, and this call may show ' + left + ' more. Narrow --from/--to, use fewer sheet frames or a bigger --grid, or split the work across calls.');
  const payload = list.map((x) => ({ mime: /\.jpe?g$/i.test(x.file) ? 'image/jpeg' : 'image/png', data: fs.readFileSync(x.file).toString('base64'), label: x.label }));
  const r = await request(['sfa-view', '--attach'], JSON.stringify(payload));
  if (!r.ok) die(r.error);
  const lines = list.map((x, i) => 'Image ' + (i + 1) + ': ' + x.label);
  process.stdout.write((note ? note + '\n' : '') + lines.join('\n') + '\n(The images follow this result.)\n');
}

async function image(args) {
  const { pos, o } = parse(args, ['max-side']);
  if (!pos.length) die('Which images?\n' + USAGE);
  const max = Math.min(Number(o['max-side']) || TILE_MAX, 4096);
  const list = pos.map((f) => ({ file: fit(need(f), max), label: f }));
  await show(list);
}

function scenes(video, from, to) {
  const args = ['-v', 'info', '-hide_banner'];
  if (from) args.push('-ss', String(from));
  if (to) args.push('-to', String(to));
  args.push('-i', video, '-an', '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-');
  const r = run('ffmpeg', args);
  const times = [];
  for (const m of String(r.stderr).matchAll(/pts_time:([\d.]+)/g)) times.push(Number(m[1]) + (from || 0));
  return times;
}

async function info(args) {
  const file = need(args[0]);
  const p = probe(file);
  const lines = [file];
  const d = Number(p.format && p.format.duration);
  if (Number.isFinite(d)) lines.push('Duration: ' + fmt(d) + ' (' + d.toFixed(2) + ' s)');
  let video = false;
  for (const s of p.streams || []) {
    if (s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) {
      video = true;
      const [a, b] = String(s.avg_frame_rate || s.r_frame_rate || '0/1').split('/').map(Number);
      lines.push('Video: ' + s.width + 'x' + s.height + ', ' + (b ? (a / b).toFixed(2) : '?') + ' fps, ' + s.codec_name);
    } else if (s.codec_type === 'audio') {
      lines.push('Audio: ' + s.codec_name + ', ' + (s.channels || '?') + ' channels, ' + (s.sample_rate || '?') + ' Hz' + (s.tags && s.tags.language ? ', ' + s.tags.language : ''));
    } else if (s.codec_type === 'subtitle') {
      lines.push('Subtitles: ' + s.codec_name + (s.tags && s.tags.language ? ', ' + s.tags.language : ''));
    }
  }
  if (video) {
    const cuts = scenes(file);
    lines.push(cuts.length ? 'Scene changes (' + cuts.length + '): ' + cuts.slice(0, 60).map(fmt).join(', ') + (cuts.length > 60 ? ', ...' : '') : 'Scene changes: none found');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function sheet(args) {
  const { pos, o } = parse(args, ['every', 'count', 'from', 'to', 'grid']);
  const file = need(pos[0]);
  const d = duration(file);
  const from = o.from ? parseTime(o.from) : 0;
  const to = Math.min(o.to ? parseTime(o.to) : d, d);
  if (to <= from) die('--to must be after --from');
  const grid = String(o.grid || '4x4').split('x').map(Number);
  if (grid.length !== 2 || grid.some((g) => !Number.isInteger(g) || g < 1 || g > 8)) die('--grid looks like 4x4 (at most 8x8)');
  const cells = grid[0] * grid[1];
  let times = [];
  if (o.scenes) {
    times = scenes(file, from, to).filter((t) => t >= from && t <= to);
    if (times.length > cells && !o.count) times = times.filter((_, i) => i % Math.ceil(times.length / cells) === 0);
  }
  if (!times.length) {
    if (o.every) {
      const step = parseTime(o.every);
      if (step <= 0) die('--every must be more than 0');
      for (let t = from; t < to; t += step) times.push(t);
    } else {
      const count = Math.max(1, Math.min(Number(o.count) || cells, 400));
      for (let i = 0; i < count; i++) times.push(from + ((to - from) * (i + 0.5)) / count);
    }
  }
  const sheets = Math.ceil(times.length / cells);
  const left = await limit();
  if (sheets > left) die('That is ' + times.length + ' frames, ' + sheets + ' sheets of ' + grid.join('x') + ', and this call may show ' + left + ' more images. Narrow --from/--to, use a longer --every or a bigger --grid.');
  const width = Math.floor(TILE_MAX / grid[0]) - 4;
  const list = [];
  for (let s = 0; s < sheets; s++) {
    const part = times.slice(s * cells, (s + 1) * cells);
    const tiles = part.map((t) => stamp(frame(file, t, width), fmt(t)));
    const target = out('jpg');
    run('montage', [...tiles, '-tile', grid[0] + 'x' + grid[1], '-geometry', '+2+2', '-background', '#202020', '-quality', '80', target]);
    list.push({ file: fit(target, TILE_MAX, 'jpg'), label: 'Sheet ' + (s + 1) + ' of ' + sheets + ': ' + part.length + ' frames, ' + fmt(part[0]) + ' to ' + fmt(part[part.length - 1]) });
  }
  await show(list, file + ': ' + times.length + ' frames from ' + fmt(from) + ' to ' + fmt(to) + ', each with its time in the corner.');
}

async function frames(args) {
  const { pos, o } = parse(args, ['at', 'max-side']);
  const file = need(pos[0]);
  if (!o.at) die('Which times? --at 0:12.5,0:13');
  const max = Math.min(Number(o['max-side']) || TILE_MAX, 4096);
  const list = String(o.at).split(',').map((t) => {
    const sec = parseTime(t);
    return { file: fit(stamp(frame(file, sec, max), fmt(sec)), max, 'jpg'), label: file + ' at ' + fmt(sec) };
  });
  await show(list);
}

function source(target) {
  const at = target.lastIndexOf('@');
  if (at > 0 && !fs.existsSync(target)) {
    const file = need(target.slice(0, at));
    return frame(file, parseTime(target.slice(at + 1)), -1);
  }
  return need(target);
}

async function crop(args) {
  const { pos, o } = parse(args, ['zoom', 'max-side']);
  if (pos.length < 2) die('Usage: sfa-view crop <image | video@time> <x,y,w,h> [--zoom 2]');
  const box = pos[1].split(',').map(Number);
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v) || v < 0) || !box[2] || !box[3]) die('The region looks like x,y,w,h in pixels, e.g. 100,80,400,300');
  const zoom = Math.min(Math.max(Number(o.zoom) || 1, 0.1), 8);
  const max = Math.min(Number(o['max-side']) || TILE_MAX, 4096);
  const target = out('png');
  run('convert', [source(pos[0]) + '[0]', '-crop', box[2] + 'x' + box[3] + '+' + box[0] + '+' + box[1], '+repage', '-resize', Math.round(zoom * 100) + '%', target]);
  await show([{ file: fit(target, max, 'png'), label: pos[0] + ' region ' + pos[1] + (zoom !== 1 ? ' at ' + zoom + 'x' : '') }]);
}

async function diff(args) {
  const { pos } = parse(args, []);
  if (pos.length !== 2) die('Usage: sfa-view diff <a> <b>');
  const a = source(pos[0]);
  let b = source(pos[1]);
  const size = (f) => run('identify', ['-format', '%wx%h', f + '[0]']).stdout.trim();
  let note = '';
  if (size(a) !== size(b)) {
    const resized = out('png');
    run('convert', [b + '[0]', '-resize', size(a) + '!', resized]);
    note = ' (' + pos[1] + ' was ' + size(b) + ', resized to ' + size(a) + ')';
    b = resized;
  }
  const marked = out('png');
  const r = run('compare', ['-metric', 'AE', '-fuzz', '2%', a + '[0]', b + '[0]', '-compose', 'src', '-highlight-color', '#FF0040', '-lowlight-color', '#FFFFFF20', marked], [1]);
  const changed = Math.round(Number(String(r.stderr).trim().split(/\s/)[0]) || 0);
  const side = out('png');
  run('montage', [a + '[0]', b + '[0]', '-tile', '2x1', '-geometry', '+4+4', '-background', '#808080', side]);
  await show(
    [
      { file: fit(side, TILE_MAX, 'png'), label: pos[0] + ' (left) and ' + pos[1] + ' (right)' },
      { file: fit(marked, TILE_MAX, 'png'), label: 'Changed pixels in red' },
    ],
    changed + ' pixels differ' + note + '.',
  );
}

async function transcript(args) {
  const { pos, o } = parse(args, ['from', 'to']);
  const file = need(pos[0]);
  const from = o.from ? parseTime(o.from) : 0;
  const cut = ['-v', 'error', '-y'];
  if (from) cut.push('-ss', String(from));
  if (o.to) cut.push('-to', String(parseTime(o.to)));
  const dir = path.join(tmp, 'audio');
  fs.mkdirSync(dir);
  run('ffmpeg', [...cut, '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', '30', '-reset_timestamps', '1', path.join(dir, 's%04d.wav')]);
  const parts = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  if (!parts.length) die(file + ' has no audio in that range.');
  const lines = [];
  for (let i = 0; i < parts.length; i++) {
    const at = from + i * 30;
    const r = await request(['sfa-view', '--transcribe', String(at)], fs.readFileSync(path.join(dir, parts[i])).toString('base64'));
    if (!r.ok) die(r.error);
    lines.push('[' + fmt(at) + '] ' + (r.text || '(no speech)'));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function pdf(args) {
  const { pos, o } = parse(args, ['pages', 'dpi']);
  const file = need(pos[0]);
  const total = Number((/Pages:\s+(\d+)/.exec(run('pdfinfo', [file]).stdout) || [])[1]) || 1;
  const [first, last] = String(o.pages || '1').split('-').map(Number);
  const a = first || 1;
  const b = Math.min(last || a, total);
  if (a < 1 || a > total || b < a) die('--pages is outside 1-' + total);
  const left = await limit();
  if (b - a + 1 > left) die('That is ' + (b - a + 1) + ' pages, and this call may show ' + left + ' more images. Use a smaller --pages range.');
  const dpi = Math.min(Math.max(Number(o.dpi) || 110, 30), 300);
  run('pdftoppm', ['-f', String(a), '-l', String(b), '-r', String(dpi), '-png', file, path.join(tmp, 'page')]);
  const pages = fs.readdirSync(tmp).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
  await show(pages.map((p, i) => ({ file: fit(path.join(tmp, p), TILE_MAX, 'png'), label: file + ' page ' + (a + i) + ' of ' + total })));
}

const [op, ...rest] = process.argv.slice(2);
const ops = { image, info, sheet, frames, crop, diff, transcript, pdf };
if (!op || op === '-h' || op === '--help' || !ops[op]) {
  process.stdout.write(USAGE + '\n');
  process.exit(op && op !== '-h' && op !== '--help' ? 1 : 0);
}
ops[op](rest).catch((error) => die(error && error.message ? error.message : String(error)));
`.replace('$USAGE', () => JSON.stringify(VIEW_USAGE));
