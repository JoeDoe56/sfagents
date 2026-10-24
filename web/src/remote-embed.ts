/**
 * The changes that make MoonlightWeb's page work inside SF Agents' Remote
 * Desktop sheet, applied to its files as SF Agents serves them (so a stock
 * MoonlightWeb install works, whatever its version, as long as the places
 * changed are still there).
 *
 * The same change, as a patch to MoonlightWeb's sources, is in
 * third_party/moonlight-web/0001-sfagents-embed.patch; js/embed.js is
 * web/public/remote/moonlight-embed.js. When a place is not found (a
 * MoonlightWeb release changed it), the file is served unchanged and the
 * sheet shows MoonlightWeb's own page instead: everything works, but the
 * stream is not started or sized by itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Edit {
  /** Where: must match exactly once. */
  find: RegExp;
  /** Replacement; "$&" is the text found. */
  replace: string;
}

const METHODS = `    /**
     * SF Agents' sheet: no host list. The first time, the stream starts at
     * once; after a stream ends, a button starts it again.
     */
    _renderEmbed(main) {
        main.replaceChildren();
        const box = document.createElement('div');
        box.className = 'mw-embed-panel';
        const text = document.createElement('p');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-primary';
        button.textContent = 'Connect';
        button.addEventListener('click', () => this._embedLaunch(text, button));
        box.append(text, button);
        main.append(box);
        onEmbedRequest('reconnect', () => {
            if (this.state !== 'launching' && this.state !== 'streaming') this._embedLaunch(text, button);
        });
        onEmbedRequest('stop', () => {
            if (this.streamView) this.streamView.quit();
        });
        if (!this._embedStarted) {
            this._embedStarted = true;
            this._embedLaunch(text, button);
        } else {
            text.textContent = 'The stream ended.';
            embedState('ended');
        }
    },

    async _embedLaunch(text, button) {
        button.hidden = true;
        text.textContent = 'Connecting…';
        embedState('connecting');
        try {
            const data = await BackendClient.getHosts();
            const raw = (data.hosts || []).find((h) => h.uuid === 'moonlightweb-native-host');
            if (!raw) throw new Error("This computer's own host is not available (MoonlightWeb found no encoder it can use).");
            const host = new Host(raw);
            const list = await BackendClient.getAppList(host.uuid);
            const apps = ((list && list.apps) || []).map((a) => new RemoteApp(a, host.uuid));
            const app = apps.find((a) => a.isMadeForStream) || apps.find((a) => a.id === 1000);
            if (!app) throw new Error('This computer offers no virtual display (on Windows, install the MoonlightWeb Virtual Display driver).');
            await this.launchApp(host, app, undefined, undefined, { skipSelfStreamWarn: true, runningChecked: true });
        } catch (e) {
            console.error('[MW] Embedded launch failed:', e);
            text.textContent = (e && e.message) || 'The stream could not start.';
            button.hidden = false;
            embedState('error', text.textContent);
        }
    },

`;

const CSS = `
/* Inside SF Agents (js/embed.js): the stream and nothing else. */
.mw-embed .app-header,
.mw-embed .app-footer,
.mw-embed .discord-fab {
    display: none !important;
}
.mw-embed,
.mw-embed body {
    background: #000;
}
.mw-embed #main-content {
    padding: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
}
.mw-embed-panel {
    text-align: center;
    color: rgba(235, 235, 245, 0.6);
    font-size: 15px;
    padding: 24px;
}
.mw-embed-panel p {
    margin: 0 0 16px;
}
`;

/** Per file (the path MoonlightWeb serves it at). */
export const EMBED_EDITS: Record<string, Edit[]> = {
  '/js/util/StreamResolution.js': [
    { find: /^/, replace: "import { EMBED, embedPixelSize } from '../embed.js';\n" },
    {
      find: /export function devicePixelSize\(win\) \{\n/,
      replace: '$&    // Inside SF Agents the stream is the frame, turned as the frame is.\n    if (EMBED && !win) return embedPixelSize();\n',
    },
    {
      find: /const made = virtualDisplaySize\(c, dev, tv\);/,
      replace: "const made = virtualDisplaySize(EMBED ? { mode: 'device' } : c, dev, tv);",
    },
  ],
  '/js/app.js': [
    {
      find: /import \{ BackendClient \} from '\.\/api\/BackendClient\.js';\n/,
      replace: "$&import { EMBED, embedState, onEmbedRequest } from './embed.js';\nimport { Host as SfaHost } from './models/Host.js';\nimport { App as RemoteApp } from './models/App.js';\n",
    },
    {
      find: /this\.transition\('host_list'\);\s*\n\s*this\._updateNavHighlight\('hosts'\);\n/,
      replace: '$&\n        // Inside SF Agents: straight to this PC\'s virtual display (embed.js).\n        if (EMBED) {\n            this._renderEmbed(main);\n            return;\n        }\n',
    },
    { find: /\n    async _renderInsecureGate\(main\) \{/, replace: `\n${METHODS.replace(/new Host\(/g, 'new SfaHost(').trimEnd()}\n$&` },
    // No first-run wizard in the sheet: SF Agents only streams this PC's virtual display.
    { find: /\n    async _maybeShowSetup\(\) \{\n/, replace: '$&        if (EMBED) return false;\n' },
    {
      find: /console\.log\(`\[MW\] State: \$\{this\.state\} -> \$\{newState\}`\);\s*\n\s*this\.state = newState;\n/,
      replace: "$&        if (EMBED && (newState === 'launching' || newState === 'streaming')) embedState(newState);\n",
    },
  ],
  '/css/layout.css': [{ find: /$(?![\s\S])/, replace: CSS }],
};

/** Applies the edits for @p file; null when one of them no longer fits. */
export function applyEmbedEdits(file: string, text: string): string | null {
  const edits = EMBED_EDITS[file];
  if (!edits) return text;
  let out = text;
  for (const e of edits) {
    const global = new RegExp(e.find.source, e.find.flags.includes('g') ? e.find.flags : `${e.find.flags}g`);
    const n = [...out.matchAll(global)].length;
    if (n !== 1) return null;
    out = out.replace(e.find, (m) => e.replace.replace(/\$&/g, () => m));
  }
  return out;
}

/** The files SF Agents changes or adds. */
export function isEmbedFile(pathname: string): boolean {
  return pathname === EMBED_SCRIPT || pathname in EMBED_EDITS;
}

export const EMBED_SCRIPT = '/js/embed.js';

let script: string | null = null;
/** js/embed.js, which SF Agents adds to MoonlightWeb's page. */
export function embedScript(): string {
  if (script === null) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    script = fs.readFileSync(path.join(here, '..', 'public', 'remote', 'moonlight-embed.js'), 'utf8');
  }
  return script;
}
