/*
 * SF Agents screen mirroring. Copyright (C) 2026 SF Agents contributors.
 * GPL-3.0-or-later.
 */

/**
 * The stream page SF Agents opens in its Screen sheet (web/public/remotesheet.js):
 * MoonlightWeb's stream view, with no host list, no settings page and no
 * accounts. It asks SF Agents' server for this computer (/api/screen/host),
 * streams its primary screen (or its virtual display where none is on), and
 * tells the sheet what it is doing with postMessage:
 *
 *   {source: 'mw-embed', type: 'state', state, message}
 *     state: 'launching' | 'streaming' | 'ended' | 'error'
 *
 * The sheet sends {target: 'mw-embed', type: 'stop' | 'reconnect'} back.
 * The query carries this device's resolution choice (`resolution`: auto,
 * device, 1080 or 720).
 */

import { MoonlightApp } from './screen-app.js';
import { onScreenPopState } from './screen-history.js';
import { BackendClient } from './api/BackendClient.js';
import { Host } from './models/Host.js';
import { App } from './models/App.js';
import { Toast } from './ui/Toast.js';
import { init as i18nInit, t } from './i18n/i18n.js';
import { startRefreshRateMonitor } from './util/RefreshRate.js';
import * as iosAudioUnlock from './audio/iosAudioUnlock.js';

const params = new URLSearchParams(window.location.search);
const EMBED = window.parent !== window;

// ── The device's resolution choice, as MoonlightWeb's Settings keep it ──────
const RESOLUTION = params.get('resolution') || 'auto';
try {
    const settings = JSON.parse(localStorage.getItem('mw-streaming-settings') || '{}');
    if (RESOLUTION === '1080' || RESOLUTION === '720') {
        settings.stream_resolution = 'fixed';
        settings.stream_height = Number(RESOLUTION);
    } else {
        settings.stream_resolution = RESOLUTION === 'device' ? 'device' : 'auto';
        delete settings.stream_height;
    }
    // The sheet is the stream's frame: never the whole screen by itself.
    settings.fullscreen_on_start = false;
    localStorage.setItem('mw-streaming-settings', JSON.stringify(settings));
} catch (_) {
    /* storage blocked: MoonlightWeb's defaults */
}

// ── What the page tells the sheet ───────────────────────────────────────────
let lastError = null;
let posted = null;
let pending = null;

function post(state, message) {
    if (!EMBED) return;
    try {
        window.parent.postMessage(
            { source: 'mw-embed', type: 'state', state, message: message || null },
            window.location.origin,
        );
    } catch (_) {
        /* parent gone */
    }
}

/**
 * The app's own states (launching, streaming, host_list, app_list…) as the
 * sheet knows them. Sent a moment later, so that a relaunch (a codec fallback:
 * host_list, then launching at once) never shows the sheet a stream that ended.
 */
function noteState(state) {
    pending = state;
    setTimeout(() => {
        if (pending === null) return;
        const s = pending;
        pending = null;
        let out;
        if (s === 'launching' || s === 'streaming') out = s;
        else if (lastError) out = 'error';
        else out = 'ended';
        if (out === 'launching') lastError = null;
        if (out === posted && out !== 'error') return;
        posted = out;
        post(out, out === 'error' ? lastError : null);
    }, 0);
}

// The sheet says what is happening; MoonlightWeb's own notes stay quiet.
const toastError = Toast.error.bind(Toast);
Toast.info = () => null;
Toast.success = () => null;
Toast.error = (message, options) => {
    lastError = typeof message === 'string' ? message : String(message);
    return toastError(message, options);
};

// ── The parts of MoonlightWeb's app that are not here ───────────────────────
Object.assign(MoonlightApp, {
    _isRealHostMachine: false,
    /** No host list behind the stream: the sheet shows what comes next. */
    _renderMainView() {
        this._nav.overlay = null;
    },
    _noteSupportSession() {},
    /** Asked of hosts whose apps outlive the stream: this one has none. */
    _showAppRunningDialog(host, app) {
        this.launchApp(host, app, undefined, undefined, { runningChecked: true, skipSelfStreamWarn: true });
    },
    /** SF Agents streams its own computer on purpose. */
    _showSelfStreamWarning(host, app) {
        this.launchApp(host, app, undefined, undefined, { skipSelfStreamWarn: true });
    },
});

const transition = MoonlightApp.transition;
MoonlightApp.transition = function (state) {
    transition.call(this, state);
    noteState(state);
};

// The stream's guard entry was popped (the stream ended, or Stop).
onScreenPopState(() => {
    const app = MoonlightApp;
    if (app._nav.overlay === 'streaming') {
        if (app.streamView) {
            if (!app.streamView._quitting) app.streamView.quit();
            app.streamView = null;
        }
        app._nav.overlay = null;
    }
});

// ── Start ───────────────────────────────────────────────────────────────────
let target = null; // {host, app}

async function stop() {
    const app = MoonlightApp;
    if (app.streamView) {
        try {
            await app.streamView.quit({ silent: true });
        } catch (_) {
            /* gone */
        }
    } else if (app.state === 'launching') {
        await app._abortStreamStartup();
    }
}

async function launch() {
    if (!target) {
        let info;
        try {
            info = await BackendClient.getHost();
        } catch (e) {
            lastError = e.message || t('launch.failed');
            post('error', lastError);
            return;
        }
        const host = new Host(info.host || {});
        const apps = (info.apps || []).map((a) => new App(a, host.uuid));
        // The screen in front of the owner, the primary first (the helper's
        // order); the virtual display only on a computer with no screen on.
        const app =
            apps.find((a) => !a.isMadeForStream && !a.isHostApp && !a.isGamescope) ||
            apps.find((a) => a.isVirtualDisplay) ||
            apps[0];
        if (!app) {
            lastError =
                (host.nativeDisplay && host.nativeDisplay.diagnostic) ||
                'This computer has no screen to stream.';
            post('error', lastError);
            return;
        }
        target = { host, app };
    }
    MoonlightApp.launchApp(target.host, target.app, undefined, undefined, {
        skipSelfStreamWarn: true,
        runningChecked: true,
    });
}

window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || d.target !== 'mw-embed') return;
    if (d.type === 'stop') void stop();
    else if (d.type === 'reconnect') void stop().then(() => setTimeout(launch, 300));
});

(async () => {
    await i18nInit();
    startRefreshRateMonitor();
    iosAudioUnlock.prime();
    post('launching');
    posted = 'launching';
    await launch();
})();
