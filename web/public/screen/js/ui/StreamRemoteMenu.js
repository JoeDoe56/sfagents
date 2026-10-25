/*
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

/**
 * StreamRemoteMenu — the stream's own menu, for a TV remote.
 *
 * On a desktop the stream is left with a key combo or the Stop button of the
 * header. A remote has neither: every key it sends goes to the host, the
 * header cannot be reached with the arrows, and Back never gets to the page
 * (the TV browser keeps it for itself — measured on TV Bro and TCL Browser,
 * 01/10/2026). So a long press of OK opens this menu (StreamView decides
 * when), and while it is up nothing goes to the host: RemoteNav moves the
 * focus between its buttons and OK presses the one that has it.
 *
 * Its "Mouse" turns the remote into the host's mouse (StreamView, with
 * stream/RemotePointer.js): the arrows steer the pointer, OK clicks, Ch+ and
 * Ch− scroll. Pressed again, the arrows go back to being arrows on the host.
 *
 * This class only draws it and reports the choice; StreamView owns what each
 * one does. It wears the share popins' look (and their class, which also
 * keeps the stream's keyboard capture off its buttons).
 */

import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../util/escapeHtml.js';

export class StreamRemoteMenu {
    /**
     * @param {{ container: Element,
     *           statsOn: () => boolean,
     *           onResume: () => void,
     *           onStats: () => void,
     *           pointerOn?: () => boolean,
     *           onPointer?: () => void,
     *           onStop: () => void,
     *           acceptsClick?: () => boolean }} opts
     *   acceptsClick: false while the OK that opened the menu is still held
     *   (and a moment after): the TV browser clicks the focused button for
     *   every repeat of a held OK, whatever the page does with the keys.
     */
    constructor(opts) {
        this._opts = opts;
        /** @type {HTMLElement|null} */
        this._el = null;
        this._onKey = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            this._opts.onResume();
        };
    }

    get isOpen() {
        return !!this._el;
    }

    _pointerOn() {
        return !!(this._opts.pointerOn && this._opts.pointerOn());
    }

    open() {
        if (this._el) return;
        const el = document.createElement('div');
        el.className = 'share-popin-overlay stream-remote-menu';
        const title = escapeHtml(t('stream.remoteMenu'));
        el.innerHTML = `
            <div class="share-popin stream-remote-menu-box" role="dialog" aria-modal="true" aria-label="${title}">
                <h3>${title}</h3>
                <div class="stream-remote-menu-actions">
                    <button type="button" class="btn" data-act="resume" data-nav-initial>${escapeHtml(t('stream.remoteResume'))}</button>
                    ${
                        this._opts.onPointer
                            ? `<button type="button" class="btn btn-secondary" data-act="pointer" aria-pressed="${this._pointerOn() ? 'true' : 'false'}">${escapeHtml(t('stream.remotePointer'))}</button>`
                            : ''
                    }
                    <button type="button" class="btn btn-secondary" data-act="stats" aria-pressed="${this._opts.statsOn() ? 'true' : 'false'}">${escapeHtml(t('stream.remoteStats'))}</button>
                    <button type="button" class="btn btn-danger" data-act="stop">${escapeHtml(t('stream.remoteStop'))}</button>
                </div>
            </div>
        `;
        el.addEventListener('click', (e) => {
            if (this._opts.acceptsClick && !this._opts.acceptsClick()) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const target = /** @type {Element} */ (e.target);
            // A click beside the box closes it, as everywhere else.
            if (target === el) {
                this._opts.onResume();
                return;
            }
            const btn = target.closest('[data-act]');
            if (!btn) return;
            const act = btn.getAttribute('data-act');
            if (act === 'resume') this._opts.onResume();
            else if (act === 'stop') this._opts.onStop();
            else if (act === 'stats') {
                this._opts.onStats();
                btn.setAttribute('aria-pressed', this._opts.statsOn() ? 'true' : 'false');
            } else if (act === 'pointer' && this._opts.onPointer) {
                // Mouse mode on: back to the stream at once, where it is used.
                this._opts.onPointer();
                btn.setAttribute('aria-pressed', this._pointerOn() ? 'true' : 'false');
                if (this._pointerOn()) this._opts.onResume();
            }
        });
        // Capture: the stream's own Escape handling must not see this one.
        document.addEventListener('keydown', this._onKey, true);
        this._opts.container.appendChild(el);
        this._el = el;
    }

    close() {
        if (!this._el) return;
        document.removeEventListener('keydown', this._onKey, true);
        this._el.remove();
        this._el = null;
    }
}
