#!/usr/bin/env node
// Builds web/public/screen, the stream page of SF Agents' screen mirroring,
// from MoonlightWeb's frontend (GPL-3.0-or-later) at the commit
// web/native/screen/UPSTREAM.json pins, the same one the helper is built from.
//
// What is kept: the stream view (js/ui/StreamView.js) and everything it needs
// to play a stream of this computer (video, audio, keyboard, mouse, touch,
// clipboard, gamepads), and the launch logic of MoonlightWeb's app (js/app.js,
// the members listed in KEEP), regenerated here as js/screen-app.js. What is
// not: the host list, settings, accounts, pairing, sharing, the tunnel, HID
// passthrough, PyroWave, the support button. Those modules are replaced by the
// stand-ins in web/screen-page/js, which also holds SF Agents' own files
// (screen-main.js, screen-history.js, the trimmed BackendClient.js, the page
// and its styles). The few edits made to MoonlightWeb's files are in PATCHES.
//
//   node scripts/vendor-screen-page.mjs [--from <moonlight-web checkout>]
//
// Without --from, the commit is fetched from GitHub (frontend/ only).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = JSON.parse(fs.readFileSync(path.join(root, 'web/native/screen/UPSTREAM.json'), 'utf8'));
const overlay = path.join(root, 'web', 'screen-page');
const target = path.join(root, 'web', 'public', 'screen');

// ── The MoonlightWeb checkout ────────────────────────────────────────────────
function checkout() {
  const i = process.argv.indexOf('--from');
  if (i > 0) return path.resolve(process.argv[i + 1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-frontend-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'inherit' });
  git('init', '-q');
  git('remote', 'add', 'origin', upstream.url);
  git('sparse-checkout', 'set', 'frontend', 'LICENSE', 'COPYRIGHT');
  git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', upstream.commit);
  git('checkout', '-q', 'FETCH_HEAD');
  return dir;
}
const mw = checkout();
const front = path.join(mw, 'frontend');
if (!fs.existsSync(path.join(front, 'js', 'ui', 'StreamView.js'))) throw new Error(`${front} is not MoonlightWeb's frontend`);

// ── The members of MoonlightWeb's app the stream needs ──────────────────────
const KEEP = `state hostListView streamView _fallbackAttemptCount _streamStartedAt _nav _GUARD_PREFIX
  _isHostMachine _isRemoteConnection launchApp _showVideoCaptureHelp _startStreamView _startAspectProbe
  _adoptNativeFormat _applyResolvedSize _warnTvOverAsk _applyResolvedFps _applyPixelBudget _autoBitrateFor
  _capToDecoder _followFrameBitrate _onClientScreenChanged _noteNativeAspect _onHostDisplayFormat
  _watchClientDynamicRange _reconcileNativeHdr _stopAspectProbe _onAspectMeasured _wireLiveView
  _createStreamView _streamWsUrl _probeUdpCached _transportLabel _onLiveLinkLost _onLiveLinkStall
  _endAfterFailedLaunch _onTransportFailed _showRelaunchLoader _abortStreamStartup _hideRelaunchLoader
  _persistHdrDisabled _persistChroma444Disabled _relaunchTransport _doRelaunchTransport _holdRelaunchLoader
  _sharePinsQuality _qualityRelaunch _seamlessRelaunch _failStandby _noteLiveQuality _restoreLiveQuality
  _promoteStandby _abortStandby _effectiveStreamHeight _onStreamCongested _armUpgradeTimer _stopUpgradeTimer
  _maybeUpgradeQuality _onStreamingQuit transition _enterLaunchFullscreen`.split(/\s+/);

/** The KEEP members of `export const MoonlightApp = {…}`, each with the comment above it. */
function appMembers(src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith('export const MoonlightApp = {'));
  let end = start;
  while (lines[end] !== '};') end++;
  const heads = [];
  for (let i = start + 1; i < end; i++) {
    const m = /^ {4}(?:async |static |get |set )?(\*?\w+)\s*(\(|:)/.exec(lines[i]);
    if (m) heads.push([i, m[1]]);
  }
  const seg = new Map();
  let prevEnd = start + 1;
  heads.forEach(([i, name], k) => {
    const next = k + 1 < heads.length ? heads[k + 1][0] : end;
    let j = next - 1;
    while (j > i && !/^ {4}[}\]]\S*,?\s*$|^ {4}\w+: .*,\s*$|^ {4}\w+: [^{]*$/.test(lines[j])) j--;
    if (/^ {4}\w+:/.test(lines[i]) && !/[{[]$/.test(lines[i].trimEnd())) j = i;
    seg.set(name, [prevEnd, j + 1]);
    prevEnd = j + 1;
  });
  const missing = KEEP.filter((n) => !seg.has(n));
  if (missing.length) throw new Error(`MoonlightWeb's app has no ${missing.join(', ')}`);
  return KEEP.map((n) => lines.slice(...seg.get(n)).join('\n').replace(/^\n+|\n+$/g, '')).join('\n\n');
}

const APP_HEADER = `/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

// Generated by scripts/vendor-screen-page.mjs from MoonlightWeb's js/app.js
// (${upstream.commit}): the members of its app that launch and run a stream.
// Do not edit; see screen-main.js for what SF Agents adds.

import { screenHistory as history } from './screen-history.js';
import { StreamView } from './ui/StreamView.js';
import { lockLandscape } from './ui/StreamViewFullscreen.js';
import { BackendClient } from './api/BackendClient.js';
import { Toast } from './ui/Toast.js';
import {
    IS_MOBILE_OR_TABLET,
    IS_HANDHELD,
    IS_LOW_MEMORY,
    IS_TV,
    resolveTearing,
    hdrClientCapability,
    chroma444ClientCapability,
    chroma444Codec,
} from './util/BrowserDetect.js';
import { currentRefreshMilliHz, autoFps, measuredFps } from './util/RefreshRate.js';
import { computeAutoBitrate } from './util/AutoBitrate.js';
import { applyPyrowaveChoice } from './util/PyrowaveCodec.js';
import { DEFAULT_ASPECT, loadHostAspect, saveHostAspect } from './util/AspectRatio.js';
import {
    readResolutionChoice,
    resolveStreamSize,
    fitPixelBudget,
    tvOverAsk,
    devicePixelSize,
    nearlySameStreamSize,
} from './util/StreamResolution.js';
import { hardwareDecodeLimit, knownHardwareDecodeLimit, capSizeToDecoder } from './util/DecoderLimit.js';
import { startAspectProbe } from './stream/AspectProbe.js';
import { recordCrashRelaunch, settledStreamState, shouldRelaunchAfterCrash } from './stream/CrashRelaunch.js';
import * as iosAudioUnlock from './audio/iosAudioUnlock.js';
import { t } from './i18n/i18n.js';
import { escapeHtml } from './util/escapeHtml.js';
import { IDENTITY_REFUSED } from './util/pairingCrypto.js';
import { probeUdp } from './api/UdpProbe.js';

/** A screen change seen while a relaunch is on its way is looked at again this long after. */
const SCREEN_RECHECK_MS = 1500;

/** SF Agents streams its own computer on purpose: never the "Streaming your own PC?" dialog. */
function selfStreamWarnMuted() {
    return true;
}

export const MoonlightApp = {
`;

// ── Edits to MoonlightWeb's files ────────────────────────────────────────────
// [file, from, to, count]: each `from` must be found exactly `count` times.
const PATCHES = [
  // The page is served under /screen/, and SF Agents' API under /api/screen/.
  ['js/audio/AudioPipeline.js', "'/js/audio/audio-processor.js", "'/screen/js/audio/audio-processor.js", 2],
  ['js/i18n/i18n.js', '`/locales/${code}.json`', '`/screen/locales/${code}.json`', 1],
  ['js/ui/StreamView.js', "fetch('/api/health'", "fetch('/api/screen/health'", 1],
  [
    'js/ui/StreamView.js',
    "this._playerMode ? '/api/share/player/leave' : `/api/hosts/${this.host.uuid}/quit`",
    "'/api/screen/quit'",
    1,
  ],
  // English only (SF Agents is).
  [
    'js/i18n/i18n.js',
    "    { code: 'fr', label: 'Français' },\n    { code: 'zh', label: '简体中文' },\n",
    '',
    1,
  ],
  // No HID passthrough: gamepads go through the Gamepad API.
  ['js/ui/StreamView.js', '    _ensureHidPassthrough() {\n', '    _ensureHidPassthrough() {\n        return null;\n', 1],
];

function patch(rel, text) {
  for (const [file, from, to, count] of PATCHES) {
    if (file !== rel) continue;
    const n = text.split(from).length - 1;
    if (n !== count) throw new Error(`${file}: expected ${count} of ${JSON.stringify(from)}, found ${n}`);
    text = text.split(from).join(to);
  }
  return text;
}

// ── The module graph, with SF Agents' stand-ins in place ────────────────────
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url/g;
const own = (rel) => path.join(overlay, rel);
const source = (rel) => (fs.existsSync(own(rel)) ? own(rel) : path.join(front, rel));

const generated = new Map();
generated.set('js/screen-app.js', `${APP_HEADER}${appMembers(fs.readFileSync(path.join(front, 'js/app.js'), 'utf8'))}\n};\n`);

const files = new Set();
const stack = ['js/screen-main.js', 'js/screen-app.js', 'js/audio/audio-processor.js'];
while (stack.length) {
  const rel = stack.pop();
  if (files.has(rel)) continue;
  const text = generated.get(rel) ?? fs.readFileSync(source(rel), 'utf8');
  files.add(rel);
  for (const m of text.matchAll(IMPORT)) {
    const spec = m.slice(1).find(Boolean);
    if (!spec.startsWith('.')) continue;
    // A JSDoc type (@type {import('…')}) is no import.
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
    if (/^\s*(\/\/|\/?\*)/.test(line)) continue;
    const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    if (!fs.existsSync(source(next)) && !generated.has(next)) throw new Error(`${rel} imports ${spec}, which is not there`);
    stack.push(next);
  }
}

// ── Write ────────────────────────────────────────────────────────────────────
fs.rmSync(target, { recursive: true, force: true });
const write = (rel, data) => {
  const out = path.join(target, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
};
let fromMw = 0;
for (const rel of [...files].sort()) {
  if (generated.has(rel)) write(rel, generated.get(rel));
  else if (fs.existsSync(own(rel))) write(rel, fs.readFileSync(own(rel)));
  else {
    write(rel, patch(rel, fs.readFileSync(path.join(front, rel), 'utf8')));
    fromMw++;
  }
}
// opus-decoder's typings are not shipped; its wasm is inline.
const CSS = ['tokens.css', 'base.css', 'layout.css', 'components.css', 'views/gamepad.css', 'stream.css'];
for (const c of CSS) write(`css/${c}`, fs.readFileSync(path.join(front, 'css', c)));
const en = fs.readFileSync(path.join(front, 'locales', 'en.json'), 'utf8').replace(/MoonlightWeb Virtual Display/g, 'SF Agents Virtual Display').replace(/MoonlightWeb/g, 'SF Agents');
write('locales/en.json', en);
for (const f of fs.readdirSync(overlay, { recursive: true })) {
  const rel = String(f).split(path.sep).join('/');
  if (rel.startsWith('js/') || fs.statSync(own(rel)).isDirectory()) continue;
  write(rel, fs.readFileSync(own(rel)));
}
write('LICENSE', fs.readFileSync(path.join(mw, 'LICENSE')));
write('COPYRIGHT', fs.readFileSync(path.join(mw, 'COPYRIGHT')));
write(
  'UPSTREAM.json',
  `${JSON.stringify(
    {
      project: upstream.project,
      url: upstream.url,
      license: upstream.license,
      commit: upstream.commit,
      generator: 'scripts/vendor-screen-page.mjs',
      copied: `frontend/js: ${fromMw} modules the stream view needs; frontend/css: ${CSS.join(', ')}; frontend/locales/en.json (MoonlightWeb renamed SF Agents)`,
      generated: 'js/screen-app.js, from the members of frontend/js/app.js the script lists',
      changed: PATCHES.map(([file, from, to]) => ({ file, from, to })),
      replaced: [...files].filter((rel) => fs.existsSync(own(rel)) && fs.existsSync(path.join(front, rel))),
      own: [...files].filter((rel) => fs.existsSync(own(rel)) && !fs.existsSync(path.join(front, rel))),
    },
    null,
    2,
  )}\n`,
);
console.log(`Vendored ${files.size} modules (${fromMw} from MoonlightWeb ${upstream.commit.slice(0, 7)}) into ${path.relative(root, target)}`);
