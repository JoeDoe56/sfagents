/**
 * Settings: everything that isn't an agent or an MCP server. This device's
 * look (glass quality, Return sends), the providers (OpenRouter keys,
 * ChatGPT and Claude sign-ins, custom endpoints), and the app settings kept
 * on the computer (the web server's port and address, sensors, terminal
 * output). The check button saves; the close button, a swipe down or Escape
 * leave everything as it was. Adding, renaming or removing a provider is its
 * own action and happens at once.
 */

import { getJson, postJson, goToSignIn } from './api.js';
import { passkeysWork, registerPasskey, cancelled } from './webauthn.js';
import { openSheet } from './modalsheet.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { showMenu } from './menu.js';
import { confirmDialog, promptDialog, showError, toast } from './dialogs.js';
import { createRow, createSection, createButton } from './vendor/sfgl/src/ui/index.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function sym(name, size = 17) {
  const i = el('i');
  applySymbol(i, name, { size });
  return i;
}

const KIND_SYMBOL = { anthropic: 'asterisk.circle', openai: 'sparkles', openrouter: 'antenna.radiowaves.left.and.right', custom: 'sparkles' };
// The companies' marks, drawn in the icon's tile like a symbol (icons/provider-*.svg).
const KIND_LOGO = { anthropic: 'icons/provider-anthropic.svg', openai: 'icons/provider-openai.svg', openrouter: 'icons/provider-openrouter.svg' };
const KINDS = [
  { kind: 'anthropic', title: 'Anthropic', detail: 'Sign in with your Claude plan.' },
  { kind: 'openai', title: 'OpenAI', detail: 'Sign in with your ChatGPT plan.' },
  { kind: 'openrouter', title: 'OpenRouter', detail: 'Hundreds of models with one API key.' },
  { kind: 'custom', title: 'Custom Endpoint', detail: 'Any OpenAI-compatible server: llama.cpp, vLLM, LM Studio, Ollama…' },
];

/** A row with a provider's icon: its logo in the tinted tile, where there is one. */
function providerRow(kind, options) {
  const row = createRow({ ...options, icon: KIND_SYMBOL[kind] ?? 'cpu', iconTint: KIND_COLOR[kind] ?? KIND_COLOR.custom });
  const glyph = KIND_LOGO[kind] && row.el.querySelector('.sf-row-icon i');
  if (glyph) {
    const url = `url("${KIND_LOGO[kind]}")`;
    glyph.style.webkitMaskImage = url;
    glyph.style.maskImage = url;
    glyph.removeAttribute('data-sf-symbol');
  }
  return row;
}

// The app forwards server events here (signin, providers, settings).
const listeners = new Set();
export function settingsEvent(name, data) {
  for (const l of listeners) l(name, data);
}
function listen(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const KIND_COLOR = { anthropic: '#D97757', openai: '#6A9BCC', openrouter: '#788C5D', custom: '#725e8d' };

/** A row with a text input at its end (Name, API Key, a port). */
function field({ label, value = '', type = 'text', placeholder = '', autocomplete = 'off', inputmode, onInput, hint }) {
  const row = createRow({ title: label, subtitle: hint, wrap: true, input: { value, type, placeholder, autocomplete, inputMode: inputmode, onInput } });
  return { row: row.el, input: row.input, api: row };
}

function switchRow(label, hint, checked, onChange) {
  const row = createRow({ title: label, subtitle: hint, wrap: true, toggle: { checked, onChange } });
  return { row: row.el, api: row };
}

function section(title, nodes, footer) {
  return createSection({ title: title ?? undefined, rows: nodes, note: footer || undefined }).el;
}

/**
 * @param {{quality: () => string, qualities: string[], previewQuality: (q: string) => void, qualityHint: () => string,
 *          enterSends: () => boolean, save: (local: {quality: string, enterSends: boolean}) => void}} device
 */
export function openSettingsSheet(device) {
  const savedLocal = { quality: device.quality(), enterSends: device.enterSends() };
  const local = { ...savedLocal };
  let server = null; // {settings: [...]}
  const draft = {}; // key → value
  let providersBox = null;
  let serverBox = null;
  let signInBox = null;
  let qualityRow = null;
  let deviceSection = null;

  const ctx = openSheet({
    title: 'Settings',
    detents: ['medium', 'large'],
    mediumHeight: () => Math.round(innerHeight * 0.56),
    className: 'st-sheet',
    build(sheet) {
      const body = sheet.body;
      // This device.
      const names = { auto: 'Auto', superfluid: 'Superfluid', glass: 'Glass', lite: 'Lite', frost: 'Frost', static: 'Solid' };
      qualityRow = createRow({
        title: 'Glass Quality',
        choices: device.qualities.map((q) => ({ value: q, label: names[q] ?? q })),
        selected: local.quality,
        onChange: (q) => {
          local.quality = q;
          device.previewQuality(q);
          showQuality();
          dirty();
        },
      });
      const enter = switchRow('Return sends', 'On a keyboard, Return sends and Shift+Return adds a line.', local.enterSends, (v) => {
        local.enterSends = v;
        dirty();
      });
      deviceSection = createSection({ title: 'This Device', rows: [qualityRow, enter.row], note: '' });
      const marker = el('div');
      marker.dataset.mediumEnd = '';
      providersBox = el('div');
      serverBox = el('div');
      signInBox = el('div');
      body.append(
        el('p', 'sf-section-note st-note', 'Agents and MCP servers are set up in their own files (the gear in the agent sheet opens an agent’s file).'),
        providersBox,
        marker,
        deviceSection.el,
        signInBox,
        serverBox,
      );
    },
    onConfirm: async () => {
      if (Object.keys(draft).length) {
        try {
          server = await postJson('/api/settings', { values: draft });
        } catch (error) {
          showError(error.message, "Couldn't save the settings");
          return false;
        }
        const restart = server.settings.filter((s) => s.restart && s.key in draft && String(s.value) !== String(s.running));
        if (restart.length) toast(`${restart.map((s) => s.label).join(' and ')} change${restart.length === 1 ? 's' : ''} when SF Agents restarts`, { symbol: 'arrow.clockwise', timeout: 3600 });
      }
      device.save(local);
      return true;
    },
    onClose: (confirmed) => {
      if (!confirmed && local.quality !== savedLocal.quality) device.previewQuality(savedLocal.quality);
      stop();
      device.onClose?.();
    },
  });

  function showQuality() {
    if (deviceSection) requestAnimationFrame(() => deviceSection.setNote(device.qualityHint()));
  }

  function dirty() {
    ctx.setDirty(local.quality !== savedLocal.quality || local.enterSends !== savedLocal.enterSends || Object.keys(draft).length > 0);
  }

  // ---------------------------------------------------------------- providers

  async function loadProviders() {
    try {
      renderProviders(await getJson('/api/providers'));
    } catch (error) {
      providersBox.replaceChildren(section('Providers', [createRow({ title: error.message, wrap: true })]));
    }
  }

  function renderProviders(data) {
    const rows = [];
    for (const p of data?.providers ?? []) {
      const row = providerRow(p.kind, {
        title: p.name,
        subtitle: [p.kindLabel, p.account ?? p.baseUrl].filter(Boolean).join(' · '),
        accessory: 'ellipsis',
        onTap: () =>
          showMenu({
            anchor: row.el,
            align: 'end',
            groups: [
              [{ label: 'Rename', symbol: 'pencil', action: () => renameProvider(p) }],
              [{ label: 'Remove', symbol: 'trash', role: 'destructive', action: () => removeProvider(p) }],
            ],
          }),
      });
      rows.push(row);
    }
    rows.push(createRow({ icon: 'plus.circle.fill', title: 'Add Provider', tintTitle: true, onTap: () => openAddProvider(data) }));
    const note = data && !data.keyring.available
      ? data.keyring.reason
      : `Keys and sign-ins are kept in the ${data?.keyring.label ?? 'system keyring'}, never in a file. Agent files name a provider in "provider", e.g. "${data?.providers?.[0]?.name ?? 'OpenRouter 1'}".`;
    const web = data?.web?.brightData;
    const webRow = createRow({
      icon: 'globe',
      iconTint: '#0a84ff',
      title: 'Bright Data',
      subtitle: !data ? '' : web ? 'Key added' : 'No key yet',
      accessory: web ? 'ellipsis' : 'chevron',
      onTap: () =>
        web
          ? showMenu({
              anchor: webRow.el,
              align: 'end',
              groups: [
                [{ label: 'Replace Key', symbol: 'key', action: () => openWebKey(true) }],
                [{ label: 'Remove Key', symbol: 'trash', role: 'destructive', action: () => removeWebKey() }],
              ],
            })
          : openWebKey(false),
    });
    providersBox.replaceChildren(
      section('Providers', rows, data ? note : ''),
      section('Web Access', [webRow], 'Agents with "web" in tools.allow search and fetch pages with `sf-web` in their shell, through Bright Data. The key stays in the keyring and in SF Agents; the sandbox never sees it.'),
    );
    ctx.refresh();
  }

  function openWebKey(replace) {
    const key = field({ label: 'API Key', type: 'password', placeholder: 'Bright Data API key', autocomplete: 'new-password' });
    // eslint-disable-next-line prefer-const
    let sheet;
    sheet = openSheet({
      title: replace ? 'Replace Bright Data Key' : 'Bright Data',
      detents: ['medium'],
      className: 'st-sheet',
      z: 1200,
      build(s) {
        s.body.append(section(null, [key.row], 'Create a key in the Bright Data control panel (Account settings → API keys). New accounts include free monthly requests; set a spend limit there too.'));
        key.input.addEventListener('input', () => sheet?.setDirty(!!key.input.value.trim()));
        setTimeout(() => key.input.focus(), 350);
      },
      onConfirm: async () => {
        try {
          await postJson('/api/providers/web', { apiKey: key.input.value });
          key.input.value = '';
          toast('Bright Data key saved', { symbol: 'checkmark', timeout: 2200 });
          loadProviders();
          return true;
        } catch (error) {
          showError(error.message, "Couldn't save the key");
          return false;
        }
      },
    });
  }

  async function removeWebKey() {
    const ok = await confirmDialog('Remove the Bright Data key?', 'Agents lose web access until you add a key again.', 'Remove', true);
    if (!ok) return;
    try {
      await postJson('/api/providers/web', { action: 'remove' });
      loadProviders();
    } catch (error) {
      showError(error.message, "Couldn't remove the key");
    }
  }

  async function renameProvider(p) {
    const name = await promptDialog('Rename Provider', p.name, 'Rename', { message: 'Agent files that use the old name will need the new one.' });
    if (!name || name === p.name) return;
    try {
      await postJson(`/api/providers/${encodeURIComponent(p.id)}`, { action: 'rename', name });
      loadProviders();
    } catch (error) {
      showError(error.message, "Couldn't rename the provider");
    }
  }

  async function removeProvider(p) {
    const ok = await confirmDialog(`Remove “${p.name}”?`, 'Its key or sign-in is deleted from the keyring. Agents that use it stop working until you add it again.', 'Remove', true);
    if (!ok) return;
    try {
      await postJson(`/api/providers/${encodeURIComponent(p.id)}`, { action: 'remove' });
      loadProviders();
    } catch (error) {
      showError(error.message, "Couldn't remove the provider");
    }
  }

  // ---------------------------------------------------------------- server settings

  async function loadServer() {
    try {
      server = await getJson('/api/settings');
      renderServer();
    } catch (error) {
      serverBox.replaceChildren(section('On This Computer', [createRow({ title: error.message, wrap: true })]));
    }
  }

  function renderServer() {
    const groups = new Map();
    for (const s of server.settings) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      const value = s.key in draft ? draft[s.key] : s.value;
      const pending = s.restart && String(s.value) !== String(s.running) ? `Now ${s.running}; ${s.value} after a restart` : '';
      const hint = [s.hint, pending].filter(Boolean).join('\n');
      let node;
      if (s.type === 'boolean') {
        node = switchRow(s.label, hint, value === true, (v) => setDraft(s, v)).row;
      } else {
        node = field({
          label: s.label,
          hint,
          value: String(value),
          inputmode: s.type === 'port' ? 'numeric' : undefined,
          onInput: (v) => setDraft(s, s.type === 'port' && /^\d+$/.test(v) ? Number(v) : v),
        }).row;
      }
      if (pending) node.classList.add('st-pending');
      groups.get(s.group).push(node);
    }
    const boxes = [];
    for (const [group, nodes] of groups) {
      const restart = server.settings.some((s) => s.group === group && s.restart);
      boxes.push(section(group, nodes, restart ? 'Takes effect the next time SF Agents starts.' : ''));
    }
    serverBox.replaceChildren(...boxes);
    ctx.refresh();
  }

  function setDraft(s, v) {
    if (String(v) === String(s.value)) delete draft[s.key];
    else draft[s.key] = v;
    dirty();
  }

  // ---------------------------------------------------------------- signing in

  const authPost = (action, body) => postJson(`/api/auth/${action}`, body);

  async function loadSignIn() {
    let status;
    let list;
    try {
      status = await getJson('/api/auth/status');
      list = await getJson('/api/auth/list');
    } catch {
      signInBox.replaceChildren(); // sign-in is off (or unreachable)
      return;
    }
    const rows = [];
    const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');
    for (const d of list.devices) {
      const mine = d.id === status.device?.id;
      const row = createRow({
        icon: /iPhone|Android/.test(d.name) ? 'phone' : 'desktopcomputer',
        iconTint: KIND_COLOR.custom,
        title: mine ? `${d.name} (this device)` : d.name,
        subtitle: `Signed in ${when(d.created)} · last seen ${when(d.lastSeen)}`,
        wrap: true,
        accessory: 'ellipsis',
        onTap: () =>
          showMenu({
            anchor: row.el,
            align: 'end',
            groups: [[{ label: mine ? 'Sign Out' : 'Sign Out Device', symbol: 'xmark', role: 'destructive', action: () => (mine ? signOut() : removeDevice(d)) }]],
          }),
      });
      rows.push(row);
    }
    for (const k of list.passkeys) {
      const row = createRow({
        icon: 'lock.shield',
        iconTint: KIND_COLOR.openai,
        title: `Passkey · ${k.name}`,
        subtitle: `Added ${when(k.created)} · last used ${when(k.lastUsed)}`,
        wrap: true,
        accessory: 'ellipsis',
        onTap: () => showMenu({ anchor: row.el, align: 'end', groups: [[{ label: 'Remove Passkey', symbol: 'trash', role: 'destructive', action: () => removePasskey(k) }]] }),
      });
      rows.push(row);
    }
    if (passkeysWork() && status.secureContext && !status.devicePasskey) {
      rows.push(
        createRow({
          icon: 'plus.circle.fill',
          title: 'Add a Passkey for This Device',
          tintTitle: true,
          onTap: async () => {
            try {
              await registerPasskey(authPost);
              toast('Passkey added', { symbol: 'checkmark' });
              loadSignIn();
            } catch (error) {
              if (!cancelled(error)) showError(error.message, "Couldn't add the passkey");
            }
          },
        }),
      );
    }
    rows.push(createRow({ title: 'Sign Out', destructive: true, center: true, onTap: signOut }));
    const note = status.secureContext
      ? 'Devices stay signed in for 90 days after they were last used. “sfagents web --new-token” replaces the token and signs every device out.'
      : 'Passkeys need HTTPS (for example Tailscale Serve, with --public-origin) or localhost. “sfagents web --new-token” replaces the token and signs every device out.';
    signInBox.replaceChildren(section('Signed-In Devices', rows, note));
    ctx.refresh();
  }

  async function signOut() {
    const ok = await confirmDialog('Sign out of this device?', 'You will need the access token or a passkey to sign in again.', 'Sign Out', true);
    if (!ok) return;
    try {
      await authPost('logout', {});
    } catch {
      // signed out anyway
    }
    goToSignIn();
  }

  async function removeDevice(d) {
    const ok = await confirmDialog(`Sign out “${d.name}”?`, 'That device will need the access token or a passkey to sign in again.', 'Sign Out', true);
    if (!ok) return;
    try {
      await authPost('remove-device', { id: d.id });
      loadSignIn();
    } catch (error) {
      showError(error.message, "Couldn't sign the device out");
    }
  }

  async function removePasskey(k) {
    const ok = await confirmDialog('Remove this passkey?', 'It can no longer sign in here. Delete it from your password manager too.', 'Remove', true);
    if (!ok) return;
    try {
      await authPost('remove-passkey', { id: k.id });
      loadSignIn();
    } catch (error) {
      showError(error.message, "Couldn't remove the passkey");
    }
  }

  const stop = listen((name) => {
    if (name === 'providers' || name === 'signin') loadProviders();
  });
  showQuality();
  renderProviders(null);
  loadProviders();
  loadServer();
  loadSignIn();
  return ctx;
}

// ------------------------------------------------------------------ adding a provider

/** The Add Provider sheet: pick a kind, then a name and the key, or sign in. */
export function openAddProvider(data) {
  let step = null; // the kind being added
  let signIn = null; // {id, url}
  let finish = null; // submits the current step
  let stop = () => {};
  const suggestions = data?.suggestions ?? {};

  const ctx = openSheet({
    title: 'Add Provider',
    detents: ['large'],
    className: 'st-sheet st-add-sheet',
    z: 1200,
    build() {},
    onConfirm: async () => (finish ? finish() : true),
    onClose: () => {
      stop();
      if (signIn && signIn.state !== 'done') postJson(`/api/providers/signin/${signIn.id}`, { action: 'cancel' }).catch(() => {});
    },
  });

  function renderKinds() {
    step = null;
    finish = null;
    ctx.setTitle('Add Provider');
    ctx.setDirty(false);
    const rows = KINDS.map((k) =>
      providerRow(k.kind, { title: k.title, subtitle: k.detail, wrap: true, accessory: 'chevron', onTap: () => renderKind(k) }),
    );
    const parts = [section(null, rows)];
    if (data && !data.keyring.available) parts.unshift(el('p', 'ag-problem st-problem', data.keyring.reason));
    else parts.push(el('p', 'sf-section-note', 'You can add several of each, like two Claude accounts; give each its own name. When one reaches its limit, an agent that lists both continues with the other.'));
    ctx.body.replaceChildren(...parts);
    ctx.refresh();
  }

  function renderKind(k) {
    step = k.kind;
    ctx.setTitle(k.title);
    const name = field({ label: 'Name', value: suggestions[k.kind] ?? k.title, autocomplete: 'off' });
    const back = createRow({
      icon: 'chevron.left',
      title: 'All Providers',
      tintTitle: true,
      onTap: () => {
        if (signIn) postJson(`/api/providers/signin/${signIn.id}`, { action: 'cancel' }).catch(() => {});
        signIn = null;
        stop();
        renderKinds();
      },
    });
    const nodes = [section(null, [back])];
    const status = el('p', 'sf-section-note st-status');
    if (k.kind === 'openrouter' || k.kind === 'custom') {
      const url = k.kind === 'custom' ? field({ label: 'Endpoint', placeholder: 'http://127.0.0.1:8080/v1', inputmode: 'url' }) : null;
      const key = field({ label: 'API Key', type: 'password', placeholder: k.kind === 'custom' ? 'Optional' : 'sk-or-…', autocomplete: 'new-password' });
      nodes.push(section(null, [name.row, ...(url ? [url.row] : []), key.row], k.kind === 'openrouter' ? 'Create a key at openrouter.ai/keys.' : 'The base URL that ends before /chat/completions. Most local servers need no key.'));
      const ready = () => ctx.setDirty(!!name.input.value.trim() && (k.kind === 'custom' ? !!url.input.value.trim() : !!key.input.value.trim()));
      for (const f of [name, url, key]) f?.input.addEventListener('input', ready);
      ready();
      finish = async () => {
        try {
          const p = await postJson('/api/providers', { kind: k.kind, name: name.input.value, apiKey: key.input.value, baseUrl: url?.input.value });
          key.input.value = '';
          toast(`Added “${p.name}”`, { symbol: 'checkmark', timeout: 2200 });
          return true;
        } catch (error) {
          showError(error.message, "Couldn't add the provider");
          return false;
        }
      };
      ctx.body.replaceChildren(...nodes);
      setTimeout(() => (k.kind === 'custom' ? url.input : key.input).focus(), 350);
    } else {
      const openai = k.kind === 'openai';
      const start = createRow({ title: openai ? 'Sign In with ChatGPT' : 'Sign In with Claude', tintTitle: true, center: true, onTap: () => startSignIn() });
      const cancelRow = createRow({ title: 'Cancel Sign-In', destructive: true, center: true, onTap: () => restart('') });
      nodes.push(
        section(null, [name.row], openai ? 'Signs in with your ChatGPT plan through Codex; usage counts against the plan, not API billing.' : 'Signs in with your Claude plan (Pro or Max) and keeps a long-lived token in the keyring.'),
        section(null, [start], 'Sign in on the computer SF Agents runs on: the page opens in a new tab there.'),
        status,
      );
      ctx.body.replaceChildren(...nodes);
      finish = null;
      ctx.setDirty(false);
      const restart = (message) => {
        if (signIn && signIn.state !== 'done') postJson(`/api/providers/signin/${signIn.id}`, { action: 'cancel' }).catch(() => {});
        signIn = null;
        stop();
        stop = () => {};
        name.input.disabled = false;
        start.update({ title: openai ? 'Sign In with ChatGPT' : 'Sign In with Claude', disabled: false });
        cancelRow.el.remove();
        status.classList.remove('st-done');
        status.textContent = message;
        ctx.refresh();
      };
      const startSignIn = async () => {
        if (signIn) {
          // The ChatGPT page can be opened again; Claude's only once.
          if (openai) postJson(`/api/providers/signin/${signIn.id}`, { action: 'reopen' }).catch((error) => (status.textContent = error.message));
          return;
        }
        start.setDisabled(true);
        status.textContent = 'Opening the sign-in page…';
        try {
          signIn = await postJson('/api/providers/signin', { kind: k.kind, name: name.input.value });
        } catch (error) {
          start.setDisabled(false);
          status.textContent = '';
          showError(error.message, "Couldn't start the sign-in");
          return;
        }
        name.input.disabled = true;
        status.textContent = signIn.opened
          ? 'Sign in on the page that opened in your browser, then close the tab and come back here.'
          : 'The browser could not be opened on this computer. Open SF Agents there and try again.';
        if (openai) start.update({ title: 'Open the Sign-In Page Again', disabled: false });
        else start.update({ title: 'Waiting for Claude…', disabled: true });
        start.el.after(cancelRow.el);
        listenForSignIn(status, restart);
        ctx.refresh();
      };
    }
    ctx.refresh();
  }

  function listenForSignIn(status, restart) {
    stop = listen((event, data) => {
      if (event !== 'signin' || data.id !== signIn?.id) return;
      if (data.state === 'done') {
        signIn.state = 'done';
        const who = data.provider?.account && data.provider.account !== 'Claude plan' ? ` as ${data.provider.account}` : '';
        status.replaceChildren(sym('checkmark.circle.fill', 15), document.createTextNode(` Signed in${who}. Added “${data.provider?.name}”.`));
        status.classList.add('st-done');
        ctx.body.querySelectorAll('.sf-row').forEach((r) => r.classList.add('disabled'));
        // A moment to see it, then the sheet goes.
        setTimeout(() => ctx.close(), 1400);
      } else if (data.state === 'failed') restart(data.error && data.error !== 'Cancelled.' ? data.error : '');
    });
  }

  renderKinds();
  return ctx;
}
