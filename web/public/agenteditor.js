/**
 * The agent editor: creating and changing an agent without its JSON file.
 * Name and description, the provider and model, the instructions (with
 * prompt files, and a live character count), what its container can reach
 * (no default: it must be chosen), the MCP servers it may use, the
 * container's memory and processors, and its voice: whether replies are read
 * aloud, and the clip Qwen3-TTS copies. The check button saves (the server
 * checks every field first, and problems show under the field); the ⋯ menu
 * duplicates the agent, resets its environment (a fresh container; the
 * workspaces stay) or deletes it. The voice clip changes at once, like a
 * provider in Settings. It saves to the same file in userdata/agents, so the
 * file can still be edited by hand.
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { showMenu } from './menu.js';
import { confirmDialog, showError, toast } from './dialogs.js';
import { toWav } from './dictation.js';
import { speak, stopSpeaking } from './speech.js';
import { createRow, createSection, createButton } from './vendor/sfgl/src/ui/index.js';

const CLIP_RATE = 24000;
const CLIP_SECONDS = 60;
const SAMPLE = 'Hello! This is how I sound when I read my replies aloud.';
const NETWORK_TITLES = { off: 'Off', pkg: 'Packages', git: 'Packages and Git', on: 'Internet' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const memoryText = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`);
const cpuText = (n) => `${n} core${n === 1 ? '' : 's'}`;

/** The instructions' length with prompt files filled in (core/src/agents/editor.ts instructionsLength). */
function instructionsLength(text, files) {
  let n = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    const ref = /^@[^\s/\\]+$/.test(t) ? files.find((f) => f.name === t.slice(1)) : undefined;
    n += (ref ? ref.chars : line.length) + 1;
  }
  return Math.max(0, n - 1);
}

/** A slider row: a title, the value, and a native range input. */
function sliderRow({ title, min, max, step, value, format, onInput }) {
  const row = el('div', 'sf-row ae-slider');
  const head = el('div', 'ae-slider-head');
  const label = el('span', 'ae-slider-title', title);
  const shown = el('span', 'ae-slider-value', format(value));
  head.append(label, shown);
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', title);
  input.addEventListener('input', () => {
    shown.textContent = format(Number(input.value));
    onInput(Number(input.value));
  });
  row.append(head, input);
  return { el: row, set: (v) => ((input.value = String(v)), (shown.textContent = format(v))) };
}

let current = null;

/**
 * Opens the editor for an agent (by name), or for a new one without.
 * @param {{agent?: string, onSaved?: (name: string) => void, onDeleted?: (name: string) => void, onEditFile?: (file: string) => void}} [o]
 */
export async function openAgentEditor(o = {}) {
  if (current) return current;
  let data;
  try {
    data = await getJson(`/api/agent-editor${o.agent ? `?agent=${encodeURIComponent(o.agent)}` : ''}`);
  } catch (error) {
    showError(error.message, "Couldn't open the agent");
    return null;
  }
  const choices = data.choices;
  let original = data.original; // null for a new agent
  let saved = structuredClone(data.form);
  const form = structuredClone(data.form);
  let voice = data.voice ?? { clip: false };
  const errors = new Map(); // field → its error node
  const parts = {};
  let stopEvents = () => {};

  const changed = () => JSON.stringify(form) !== JSON.stringify(saved);
  const dirty = () => ctx?.setDirty(changed() || !original);

  /** A field's error, shown under its section. */
  function errorNode(field) {
    const node = el('p', 'ae-error');
    node.hidden = true;
    errors.set(field, node);
    return node;
  }
  function showErrors(map = {}) {
    let first = null;
    for (const [field, node] of errors) {
      const text = map[field] ?? '';
      node.textContent = text;
      node.hidden = !text;
      if (text && !first) first = node;
    }
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function set(field, value) {
    form[field] = value;
    const node = errors.get(field);
    if (node && !node.hidden) node.hidden = true;
    dirty();
  }

  let ctx = null;
  const more = createButton({ symbol: 'ellipsis.circle', aria: 'More', size: 'large', onClick: () => moreMenu() });
  ctx = openSheet({
    title: original ? original : 'New Agent',
    detents: ['large'],
    className: 'st-sheet ae-sheet',
    trailing: original ? more.el : undefined,
    build(sheet) {
      const body = sheet.body;
      if (data.problem) body.append(createSection({ rows: [createRow({ title: `This agent's file did not load: ${data.problem}`, wrap: true, destructive: true })], note: 'Saving the form below replaces what is wrong.' }).el);

      // Name and description.
      const name = createRow({ title: 'Name', wrap: true, input: { value: form.name, placeholder: 'researcher', autocomplete: 'off', onInput: (v) => set('name', v) } });
      const description = createRow({ title: 'Description', wrap: true, input: { value: form.description, placeholder: 'What it is for', onInput: (v) => set('description', v) } });
      body.append(createSection({ rows: [name, description], note: 'The name is the file name in userdata/agents. Other agents that may message this one follow a rename.' }).el, errorNode('name'), errorNode('description'));

      // Provider and model.
      parts.provider = createRow({ title: 'Provider', value: form.provider || 'Any', accessory: 'menu', onTap: () => pickProvider() });
      parts.model = createRow({ title: 'Model', wrap: true, input: { value: form.model, placeholder: form.provider ? 'model id' : 'the provider’s default', onInput: (v) => set('model', v) } });
      parts.models = createRow({ title: 'Suggested Models', tintTitle: true, onTap: () => pickModel() });
      body.append(createSection({ title: 'Model', rows: [parts.provider, parts.model, parts.models], note: 'With Any, the agent replies with the account picked in the agent sheet (or the first provider added in Settings).' }).el, errorNode('provider'), errorNode('model'));

      // Instructions.
      const area = el('textarea', 'ae-instructions');
      area.value = form.instructions;
      area.placeholder = 'You are…';
      area.rows = 10;
      area.spellcheck = true;
      parts.count = el('span', 'ae-count');
      const countLine = () => (parts.count.textContent = `${instructionsLength(form.instructions, choices.promptFiles).toLocaleString()} characters`);
      area.addEventListener('input', () => {
        set('instructions', area.value);
        countLine();
      });
      parts.area = area;
      const box = el('div', 'sf-row ae-area');
      box.append(area);
      const prompt = createRow({ title: 'Insert a Prompt File', tintTitle: true, disabled: !choices.promptFiles.length, onTap: (anchor) => pickPrompt(anchor) });
      const instructions = createSection({ title: 'Instructions', rows: [box, prompt], note: 'A line with just @name.txt pulls in that file from the prompts folder, so agents can share instructions.' });
      instructions.el.querySelector('.sf-section-title')?.append(parts.count);
      countLine();
      body.append(instructions.el, errorNode('instructions'));

      // Network level: required, no default.
      parts.network = choices.networkLevels.map((l) =>
        createRow({
          title: NETWORK_TITLES[l.value] ?? l.value,
          subtitle: l.text.charAt(0).toUpperCase() + l.text.slice(1),
          wrap: true,
          accessory: form.network === l.value ? 'check' : 'none',
          onTap: () => {
            set('network', l.value);
            parts.network.forEach((r, i) => r.update({ accessory: choices.networkLevels[i].value === l.value ? 'check' : 'none' }));
          },
        }),
      );
      body.append(createSection({ title: 'Network', rows: parts.network, note: 'What commands in the agent’s container can reach. Each level includes the one before. Never this computer or your local network.' }).el, errorNode('network'));

      // MCP servers: attaching one is the permission.
      const servers = choices.mcpServers.map((s) =>
        createRow({
          title: s,
          toggle: {
            checked: form.mcpServers.includes(s),
            onChange: (on) => set('mcpServers', on ? [...form.mcpServers, s].sort() : form.mcpServers.filter((x) => x !== s)),
          },
        }),
      );
      const missing = form.mcpServers.filter((s) => !choices.mcpServers.includes(s));
      for (const s of missing) servers.push(createRow({ title: s, subtitle: 'Not in mcp.json', destructive: true, toggle: { checked: true, onChange: (on) => set('mcpServers', on ? [...form.mcpServers, s] : form.mcpServers.filter((x) => x !== s)) } }));
      body.append(
        createSection({ title: 'MCP Servers', rows: servers.length ? servers : [createRow({ title: 'No MCP servers are set up (mcp.json).', wrap: true })], note: 'The agent reaches these with the sfa-mcp command. Tools ask before they run unless auto-approved in the file.' }).el,
        errorNode('mcpServers'),
      );

      // The container.
      const m = choices.memoryMb;
      const c = choices.cpus;
      parts.memory = sliderRow({ title: 'Memory', min: m.min, max: m.max, step: m.step, value: Math.min(form.memoryMb, m.max), format: memoryText, onInput: (v) => set('memoryMb', v) });
      parts.cpus = sliderRow({ title: 'Processors', min: c.min, max: c.max, step: c.step, value: Math.min(form.cpus, c.max), format: cpuText, onInput: (v) => set('cpus', v) });
      body.append(createSection({ title: 'Container', rows: [parts.memory.el, parts.cpus.el], note: `Up to ${memoryText(m.max)}, which every agent's container shares (on Windows, the WSL Memory Cap in Settings). A change takes effect at the agent's next command: its container is made again, and /workspaces stays.` }).el, errorNode('memoryMb'), errorNode('cpus'));

      // Voice.
      parts.speak = createRow({ title: 'Read Replies Aloud', subtitle: 'On the device you are using', wrap: true, toggle: { checked: form.speak, onChange: (on) => set('speak', on) } });
      parts.clip = createRow({ title: 'Voice', wrap: true, accessory: 'ellipsis', onTap: () => clipMenu() });
      parts.transcript = createRow({ title: 'Transcript', wrap: true, input: { value: voice.transcript ?? '', placeholder: 'Filled in from the clip', onInput: () => {} } });
      parts.transcript.input?.addEventListener('change', () => saveTranscript());
      parts.again = createRow({ title: 'Transcribe Again', tintTitle: true, onTap: () => transcribeAgain() });
      parts.sample = createRow({ title: 'Play a Sample', tintTitle: true, onTap: () => playSample() });
      body.append(
        createSection({
          title: 'Voice',
          rows: [parts.speak, parts.clip, parts.transcript, parts.again, parts.sample],
          note: 'Qwen3-TTS copies the voice from a clean recording of one speaker, at least 10 seconds long (its first 15 seconds), and what is said in it. Qwen3-ASR writes the transcript; correct it where it misheard. The clip changes at once.',
        }).el,
        errorNode('speak'),
      );
      showVoice();
      showProvider();
    },
    onConfirm: () => save(),
    onClose: () => {
      current = null;
      stopEvents();
      stopSpeaking();
    },
  });
  current = ctx;
  dirty();

  function showProvider() {
    parts.provider.setValue(form.provider || 'Any');
    const models = modelsFor(form.provider);
    parts.models.el.hidden = !models.length;
    if (parts.model.input) parts.model.input.placeholder = form.provider ? 'model id' : 'the provider’s default';
  }

  function modelsFor(provider) {
    return choices.providers.find((p) => p.name.toLowerCase() === provider.toLowerCase())?.models ?? [];
  }

  function pickProvider() {
    const item = (name, detail) => ({
      label: name || 'Any',
      detail,
      checked: (form.provider || '') === name,
      action: () => {
        set('provider', name);
        if (!name) {
          set('model', '');
          if (parts.model.input) parts.model.input.value = '';
        } else if (!form.model && modelsFor(name)[0]) {
          set('model', modelsFor(name)[0]);
          if (parts.model.input) parts.model.input.value = form.model;
        }
        showProvider();
      },
    });
    const listed = choices.providers.map((p) => item(p.name, p.kind));
    if (form.provider && !choices.providers.some((p) => p.name.toLowerCase() === form.provider.toLowerCase())) listed.push(item(form.provider, 'not in Settings'));
    showMenu({ anchor: parts.provider.anchor, align: 'end', placement: 'cover', groups: [[item('', 'Whichever is picked in the app')], listed] });
  }

  function pickModel() {
    showMenu({
      anchor: parts.models.el,
      align: 'start',
      groups: [
        modelsFor(form.provider).map((m) => ({
          label: m,
          checked: m === form.model,
          action: () => {
            set('model', m);
            if (parts.model.input) parts.model.input.value = m;
          },
        })),
      ],
    });
  }

  function pickPrompt(anchor) {
    showMenu({
      anchor,
      align: 'start',
      groups: [
        choices.promptFiles.map((f) => ({
          label: f.name,
          detail: `${f.chars.toLocaleString()} characters`,
          action: () => {
            const a = parts.area;
            const at = a.selectionStart ?? a.value.length;
            const before = a.value.slice(0, at);
            const line = `${before && !before.endsWith('\n') ? '\n' : ''}@${f.name}\n`;
            a.setRangeText(line, at, a.selectionEnd ?? at, 'end');
            a.dispatchEvent(new Event('input'));
            a.focus();
          },
        })),
      ],
    });
  }

  async function save() {
    try {
      const res = await fetch('/api/agent-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', form, ...(original ? { original } : {}) }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 422) {
        showErrors(out.errors ?? {});
        return false;
      }
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      showErrors({});
      toast(original ? `Saved ${out.original}` : `Made ${out.original}`, { symbol: 'checkmark', timeout: 2200 });
      original = out.original;
      saved = structuredClone(out.form);
      o.onSaved?.(out.original);
      return true;
    } catch (error) {
      showError(error.message, "Couldn't save the agent");
      return false;
    }
  }

  function moreMenu() {
    showMenu({
      anchor: more.el,
      align: 'end',
      groups: [
        [
          { label: 'Duplicate', symbol: 'plus.square.on.square', action: () => duplicate() },
          data.file && o.onEditFile ? { label: 'Edit Agent File', symbol: 'doc.text', action: () => (ctx.close(), o.onEditFile(data.file)) } : null,
        ].filter(Boolean),
        [{ label: 'Reset Environment…', symbol: 'arrow.counterclockwise', action: () => reset() }],
        [{ label: 'Delete Agent…', symbol: 'trash', role: 'destructive', disabled: data.onlyAgent, action: () => remove() }],
      ],
    });
  }

  async function duplicate() {
    if (changed() && !(await confirmDialog('Duplicate without your changes?', 'The copy is made from the saved agent. Save first to include what you changed.', 'Duplicate'))) return;
    try {
      const out = await postJson('/api/agent-editor', { action: 'duplicate', agent: original });
      toast(`Made ${out.original}`, { symbol: 'plus.square.on.square', timeout: 2200 });
      ctx.close();
      setTimeout(() => openAgentEditor({ ...o, agent: out.original }), 350);
    } catch (error) {
      showError(error.message, "Couldn't duplicate the agent");
    }
  }

  async function reset() {
    if (!(await confirmDialog(`Reset ${original}'s environment?`, 'Its container and home folder are made again from the agent image: anything it installed or keeps outside /workspaces goes. /workspaces stays as it is.', 'Reset', true))) return;
    try {
      await postJson('/api/agent-editor', { action: 'reset', agent: original });
      toast('Environment reset', { symbol: 'arrow.counterclockwise', timeout: 2200 });
    } catch (error) {
      showError(error.message, "Couldn't reset the environment");
    }
  }

  async function remove() {
    if (!(await confirmDialog(`Delete ${original}?`, 'Its agent file, container and voice are removed. /workspaces and the conversation stay.', 'Delete', true))) return;
    try {
      await postJson('/api/agent-editor', { action: 'delete', agent: original });
      toast(`Deleted ${original}`, { symbol: 'trash', timeout: 2200 });
      saved = structuredClone(form);
      ctx.setDirty(false);
      ctx.close();
      o.onDeleted?.(original);
    } catch (error) {
      showError(error.message, "Couldn't delete the agent");
    }
  }

  // ---------------------------------------------------------------- voice

  function showVoice() {
    const has = !!original;
    parts.clip.update({ subtitle: !has ? 'Save the agent first' : voice.clip ? 'Set: Qwen3-TTS copies this voice' : 'None: its replies are not read aloud', disabled: !has });
    if (parts.transcript.input && document.activeElement !== parts.transcript.input) parts.transcript.input.value = voice.transcript ?? '';
    parts.transcript.el.hidden = !voice.clip;
    parts.again.el.hidden = !voice.clip;
    parts.again.update({ title: voice.transcribing ? 'Transcribing…' : 'Transcribe Again' });
    parts.again.setDisabled(!!voice.transcribing);
    parts.sample.el.hidden = !voice.clip;
    ctx?.refresh?.();
  }

  const voiceUrl = () => `/api/voice?agent=${encodeURIComponent(original)}`;

  function clipMenu() {
    if (!original) return;
    showMenu({
      anchor: parts.clip.el,
      align: 'end',
      groups: [
        [{ label: voice.clip ? 'Replace Clip…' : 'Choose a Clip…', symbol: 'folder', action: () => chooseClip() }],
        voice.clip ? [{ label: 'Play Clip', symbol: 'play.fill', action: () => new Audio(`${voiceUrl()}&t=${Date.now()}`).play().catch((e) => showError(e.message, "Couldn't play the clip")) }] : [],
        voice.clip ? [{ label: 'Remove Clip', symbol: 'trash', role: 'destructive', action: () => removeClip() }] : [],
      ],
    });
  }

  function chooseClip() {
    const input = el('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus,.webm';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        // Whatever the format, Qwen3-TTS gets a mono WAV at its own rate.
        const wav = await toWav(file, { rate: CLIP_RATE, maxSeconds: CLIP_SECONDS });
        const res = await fetch(voiceUrl(), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
        voice = out;
        showVoice();
        toast('Voice set', { symbol: 'checkmark', timeout: 2200 });
      } catch (error) {
        showError(error.name === 'EncodingError' ? 'The browser could not read that file as audio.' : error.message, "Couldn't set the voice clip");
      }
    });
    input.click();
  }

  async function removeClip() {
    if (!(await confirmDialog('Remove the voice?', 'This agent’s replies are not read aloud without one.', 'Remove', true))) return;
    try {
      const res = await fetch(voiceUrl(), { method: 'DELETE' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      voice = out;
      showVoice();
    } catch (error) {
      showError(error.message, "Couldn't remove the clip");
    }
  }

  async function saveTranscript() {
    try {
      voice = (await postJson('/api/agent-editor', { action: 'voice-text', agent: original, text: parts.transcript.input.value })).voice;
      showVoice();
    } catch (error) {
      showError(error.message, "Couldn't save the transcript");
    }
  }

  async function transcribeAgain() {
    voice = { ...voice, transcribing: true };
    showVoice();
    try {
      voice = (await postJson('/api/agent-editor', { action: 'transcribe-voice', agent: original })).voice;
    } catch (error) {
      voice = { ...voice, transcribing: false };
      showError(error.message, "Couldn't transcribe the clip");
    }
    showVoice();
  }

  async function playSample() {
    try {
      await speak(SAMPLE, original);
    } catch (error) {
      showError(error.message, "Couldn't speak");
    }
  }

  // A new clip's transcript arrives when Qwen3-ASR has written it.
  const onVoice = (e) => {
    if (e.detail?.agent?.toLowerCase() === original?.toLowerCase()) {
      voice = e.detail.voice;
      showVoice();
    }
  };
  window.addEventListener('sfa-agent-voice', onVoice);
  stopEvents = () => window.removeEventListener('sfa-agent-voice', onVoice);
  return ctx;
}
