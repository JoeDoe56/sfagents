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

const KIND_SYMBOL = { openrouter: 'antenna.radiowaves.left.and.right', openai: 'sparkles', anthropic: 'asterisk.circle', custom: 'desktopcomputer' };
const KINDS = [
  { kind: 'openrouter', title: 'OpenRouter', detail: 'Hundreds of models with one API key.' },
  { kind: 'openai', title: 'OpenAI', detail: 'Sign in with your ChatGPT plan.' },
  { kind: 'anthropic', title: 'Anthropic', detail: 'Sign in with your Claude plan.' },
  { kind: 'custom', title: 'Custom Endpoint', detail: 'Any OpenAI-compatible server: llama.cpp, vLLM, LM Studio, Ollama…' },
];

// The app forwards server events here (signin, providers, settings).
const listeners = new Set();
export function settingsEvent(name, data) {
  for (const l of listeners) l(name, data);
}
function listen(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function field({ label, value = '', type = 'text', placeholder = '', autocomplete = 'off', inputmode, onInput }) {
  const row = el('label', 'ui-row ui-field');
  const name = el('span', 'ui-field-label', label);
  const input = el('input', 'ui-field-input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = autocomplete;
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  if (inputmode) input.inputMode = inputmode;
  input.addEventListener('input', () => onInput?.(input.value));
  row.append(name, input);
  return { row, input };
}

function switchRow(label, hint, checked, onChange) {
  const row = el('label', 'ui-row st-switch');
  const text = el('span', 'ui-row-label');
  text.append(el('span', '', label));
  if (hint) text.append(el('small', 'ui-row-hint', hint));
  const input = el('input', 'ui-switch');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(text, input);
  return { row, input };
}

function section(title, nodes, footer) {
  const s = el('section', 'ui-section');
  if (title) s.append(el('h3', 'ui-section-title', title));
  const g = el('div', 'ui-group');
  g.append(...nodes);
  s.append(g);
  if (footer) s.append(el('p', 'ui-caption', footer));
  return s;
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
  let qualityButtons = [];
  let qualityHint = null;

  const ctx = openSheet({
    title: 'Settings',
    detents: ['medium', 'large'],
    mediumHeight: () => Math.round(innerHeight * 0.56),
    className: 'st-sheet',
    build(sheet) {
      const body = sheet.body;
      // This device.
      const seg = el('div', 'segmented');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', 'Glass quality');
      const names = { auto: 'Auto', superfluid: 'Superfluid', glass: 'Glass', lite: 'Lite', frost: 'Frost', static: 'Solid' };
      for (const q of device.qualities) {
        const b = el('button', '', names[q] ?? q);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.value = q;
        b.addEventListener('click', () => {
          local.quality = q;
          device.previewQuality(q);
          showQuality();
          dirty();
        });
        seg.append(b);
        qualityButtons.push(b);
      }
      qualityHint = el('p', 'ui-caption');
      const quality = el('section', 'ui-section');
      quality.append(el('h3', 'ui-section-title', 'Glass Quality'), seg, qualityHint);
      const enter = switchRow('Return sends', 'On a keyboard, Return sends and Shift+Return adds a line.', local.enterSends, (v) => {
        local.enterSends = v;
        dirty();
      });
      const marker = el('div');
      marker.dataset.mediumEnd = '';
      providersBox = el('div');
      serverBox = el('div');
      signInBox = el('div');
      body.append(
        el('p', 'ui-caption st-note', 'Agents and MCP servers are set up in their own files (the gear in the agent sheet opens an agent’s file).'),
        providersBox,
        marker,
        quality,
        section('This Device', [enter.row]),
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
    for (const b of qualityButtons) b.setAttribute('aria-checked', String(b.dataset.value === local.quality));
    if (qualityHint) requestAnimationFrame(() => (qualityHint.textContent = device.qualityHint()));
  }

  function dirty() {
    ctx.setDirty(local.quality !== savedLocal.quality || local.enterSends !== savedLocal.enterSends || Object.keys(draft).length > 0);
  }

  // ---------------------------------------------------------------- providers

  async function loadProviders() {
    try {
      renderProviders(await getJson('/api/providers'));
    } catch (error) {
      providersBox.replaceChildren(section('Providers', [el('div', 'ui-row', error.message)]));
    }
  }

  function renderProviders(data) {
    const rows = [];
    for (const p of data?.providers ?? []) {
      const row = el('button', 'ui-row tappable st-provider');
      row.type = 'button';
      const icon = el('span', `st-kind ${p.kind}`);
      icon.append(sym(KIND_SYMBOL[p.kind] ?? 'cpu', 15));
      const text = el('span', 'ui-row-label st-two');
      text.append(el('span', '', p.name), el('small', 'ui-row-hint', [p.kindLabel, p.account ?? p.baseUrl].filter(Boolean).join(' · ')));
      row.append(icon, text, sym('ellipsis', 15));
      row.addEventListener('click', () =>
        showMenu({
          anchor: row,
          align: 'end',
          groups: [
            [{ label: 'Rename', symbol: 'pencil', action: () => renameProvider(p) }],
            [{ label: 'Remove', symbol: 'trash', role: 'destructive', action: () => removeProvider(p) }],
          ],
        }),
      );
      rows.push(row);
    }
    const add = el('button', 'ui-row tappable st-add');
    add.type = 'button';
    add.append(sym('plus.circle.fill', 19), el('span', 'ui-row-label', 'Add Provider'));
    add.addEventListener('click', () => openAddProvider(data));
    rows.push(add);
    const note = data && !data.keyring.available
      ? data.keyring.reason
      : `Keys and sign-ins are kept in the ${data?.keyring.label ?? 'system keyring'}, never in a file. Agent files name a provider in "provider", e.g. "${data?.providers?.[0]?.name ?? 'OpenRouter 1'}".`;
    providersBox.replaceChildren(section('Providers', rows, data ? note : ''));
    ctx.refresh();
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
      serverBox.replaceChildren(section('On This Computer', [el('div', 'ui-row', error.message)]));
    }
  }

  function renderServer() {
    const groups = new Map();
    for (const s of server.settings) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      const value = s.key in draft ? draft[s.key] : s.value;
      let node;
      if (s.type === 'boolean') {
        node = switchRow(s.label, s.hint, value === true, (v) => setDraft(s, v)).row;
      } else {
        const f = field({
          label: s.label,
          value: String(value),
          type: s.type === 'port' ? 'text' : 'text',
          inputmode: s.type === 'port' ? 'numeric' : undefined,
          onInput: (v) => setDraft(s, s.type === 'port' && /^\d+$/.test(v) ? Number(v) : v),
        });
        node = el('div', 'st-field-wrap');
        node.append(f.row, el('small', 'ui-row-hint st-field-hint', s.hint));
      }
      if (s.restart && String(s.value) !== String(s.running)) {
        node.classList.add('st-pending');
        node.append(el('small', 'st-restart', `Now ${s.running}; ${s.value} after a restart`));
      }
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
      const row = el('button', 'ui-row tappable st-provider');
      row.type = 'button';
      const icon = el('span', 'st-kind custom');
      icon.append(sym(/iPhone|Android/.test(d.name) ? 'phone' : 'desktopcomputer', 15));
      const text = el('span', 'ui-row-label st-two');
      text.append(el('span', '', mine ? `${d.name} (this device)` : d.name), el('small', 'ui-row-hint', `Signed in ${when(d.created)} · last seen ${when(d.lastSeen)}`));
      row.append(icon, text, sym('ellipsis', 15));
      row.addEventListener('click', () =>
        showMenu({
          anchor: row,
          align: 'end',
          groups: [[{ label: mine ? 'Sign Out' : 'Sign Out Device', symbol: 'xmark', role: 'destructive', action: () => (mine ? signOut() : removeDevice(d)) }]],
        }),
      );
      rows.push(row);
    }
    for (const k of list.passkeys) {
      const row = el('button', 'ui-row tappable st-provider');
      row.type = 'button';
      const icon = el('span', 'st-kind openai');
      icon.append(sym('lock.shield', 15));
      const text = el('span', 'ui-row-label st-two');
      text.append(el('span', '', `Passkey · ${k.name}`), el('small', 'ui-row-hint', `Added ${when(k.created)} · last used ${when(k.lastUsed)}`));
      row.append(icon, text, sym('ellipsis', 15));
      row.addEventListener('click', () =>
        showMenu({ anchor: row, align: 'end', groups: [[{ label: 'Remove Passkey', symbol: 'trash', role: 'destructive', action: () => removePasskey(k) }]] }),
      );
      rows.push(row);
    }
    if (passkeysWork() && status.secureContext && !status.devicePasskey) {
      const add = el('button', 'ui-row tappable st-add');
      add.type = 'button';
      add.append(sym('plus.circle.fill', 19), el('span', 'ui-row-label', 'Add a Passkey for This Device'));
      add.addEventListener('click', async () => {
        try {
          await registerPasskey(authPost);
          toast('Passkey added', { symbol: 'checkmark' });
          loadSignIn();
        } catch (error) {
          if (!cancelled(error)) showError(error.message, "Couldn't add the passkey");
        }
      });
      rows.push(add);
    }
    const out = el('button', 'ui-row tappable st-signout');
    out.type = 'button';
    out.append(el('span', 'ui-row-label', 'Sign Out'));
    out.addEventListener('click', signOut);
    rows.push(out);
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
    const rows = KINDS.map((k) => {
      const row = el('button', 'ui-row tappable st-provider');
      row.type = 'button';
      const icon = el('span', `st-kind ${k.kind}`);
      icon.append(sym(KIND_SYMBOL[k.kind], 15));
      const text = el('span', 'ui-row-label st-two');
      text.append(el('span', '', k.title), el('small', 'ui-row-hint', k.detail));
      row.append(icon, text, sym('chevron.right', 12));
      row.addEventListener('click', () => renderKind(k));
      return row;
    });
    const parts = [section(null, rows)];
    if (data && !data.keyring.available) parts.unshift(el('p', 'ag-problem st-problem', data.keyring.reason));
    else parts.push(el('p', 'ui-caption', 'You can add several of each, like two Claude accounts; give each its own name. When one reaches its limit, an agent that lists both continues with the other.'));
    ctx.body.replaceChildren(...parts);
    ctx.refresh();
  }

  function renderKind(k) {
    step = k.kind;
    ctx.setTitle(k.title);
    const name = field({ label: 'Name', value: suggestions[k.kind] ?? k.title, autocomplete: 'off' });
    const back = el('button', 'ui-row tappable st-back');
    back.type = 'button';
    back.append(sym('chevron.left', 13), el('span', 'ui-row-label', 'All Providers'));
    back.addEventListener('click', () => {
      if (signIn) postJson(`/api/providers/signin/${signIn.id}`, { action: 'cancel' }).catch(() => {});
      signIn = null;
      stop();
      renderKinds();
    });
    const nodes = [back];
    const status = el('p', 'ui-caption st-status');
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
      const start = el('button', 'ui-button primary st-signin', openai ? 'Continue with ChatGPT' : 'Continue with Claude');
      start.type = 'button';
      const finishBox = el('div');
      nodes.push(
        section(null, [name.row], openai ? 'Signs in with your ChatGPT plan; usage counts against the plan, not API billing.' : 'Signs in with your Claude plan (Pro or Max) and keeps a long-lived token in the keyring.'),
        start,
        status,
        finishBox,
      );
      ctx.body.replaceChildren(...nodes);
      finish = null;
      ctx.setDirty(false);
      start.addEventListener('click', async () => {
        if (signIn) {
          window.open(signIn.url, '_blank', 'noopener');
          return;
        }
        // Open the tab now, while the tap still counts as one (pop-up blockers).
        const tab = window.open('about:blank', '_blank');
        start.disabled = true;
        status.textContent = 'Starting…';
        try {
          signIn = await postJson('/api/providers/signin', { kind: k.kind, name: name.input.value });
        } catch (error) {
          tab?.close();
          start.disabled = false;
          status.textContent = '';
          showError(error.message, "Couldn't start the sign-in");
          return;
        }
        if (tab) {
          try {
            tab.opener = null;
          } catch {
            // cross-origin already
          }
          tab.location.href = signIn.url;
        }
        name.input.disabled = true;
        start.textContent = 'Open the Sign-in Page Again';
        start.disabled = false;
        renderFinish(openai, finishBox, status);
      });
    }
    ctx.refresh();
  }

  function renderFinish(openai, box, status) {
    const input = field({
      label: openai ? 'Address' : 'Code',
      placeholder: openai ? 'http://127.0.0.1:…/auth/callback?…' : 'Paste the code from Claude',
      inputmode: openai ? 'url' : undefined,
    });
    status.textContent = openai
      ? 'Sign in on the page that opened. On this computer it finishes by itself.'
      : 'Sign in on the page that opened. Claude then shows a code: paste it here.';
    box.replaceChildren(
      section(
        openai ? 'Signing in on another device?' : null,
        [input.row],
        openai ? 'The last page won’t load on a phone or another computer. Copy its address from the address bar and paste it here.' : '',
      ),
    );
    input.input.addEventListener('input', () => ctx.setDirty(!!input.input.value.trim()));
    finish = async () => {
      status.textContent = 'Checking…';
      try {
        const r = await postJson(`/api/providers/signin/${signIn.id}`, openai ? { callbackUrl: input.input.value } : { code: input.input.value });
        if (r.state === 'done') {
          signIn.state = 'done';
          toast(`Signed in. Added “${r.provider?.name}”`, { symbol: 'checkmark', timeout: 2600 });
          return true;
        }
        status.textContent = r.error ?? 'The sign-in did not finish.';
        return false;
      } catch (error) {
        status.textContent = error.message;
        return false;
      }
    };
    stop = listen((event, data) => {
      if (event !== 'signin' || data.id !== signIn?.id) return;
      if (data.state === 'done') {
        signIn.state = 'done';
        toast(`Signed in${data.provider?.account && data.provider.account !== 'Claude plan' ? ` as ${data.provider.account}` : ''}. Added “${data.provider?.name}”`, { symbol: 'checkmark', timeout: 2600 });
        ctx.close();
      } else if (data.state === 'failed') status.textContent = data.error ?? 'The sign-in failed. Start again.';
    });
    ctx.refresh();
  }

  renderKinds();
  return ctx;
}
