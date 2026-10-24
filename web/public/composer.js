/**
 * The message composer: the header of the main bar sheet. A growing text
 * field (with the plus and the mic at its ends) beside the agent / send /
 * stop circle, and, when files are attached, a strip of them above. All of
 * it is sfgl's own bar, field and button, so it morphs, stretches and
 * presses like the rest of the app.
 */

import { createBar, createButton, createField } from './vendor/sfgl/src/ui/index.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';

const AGENT_FACE = `<svg viewBox="0 0 170 120" width="24" height="17"><defs><mask id="agentFace" maskUnits="userSpaceOnUse" x="0" y="0" width="170" height="120"><path fill="#fff" d="M24 8H144V48H164V68H144V92H134V114H120V92H110V114H96V92H72V92H58V114H44V92H34V114H20V92H24V68H4V48H24Z"/><rect x="48" y="32" width="11" height="20" rx="3"/><path d="M105 42L116 36L125 42" fill="none" stroke="#000" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M76 62Q84 72 92 62" fill="none" stroke="#000" stroke-width="5" stroke-linecap="round"/></mask></defs><path fill="currentColor" mask="url(#agentFace)" d="M0 0H170V120H0Z"/></svg>`;

function span(className, hidden = false) {
  const node = document.createElement('span');
  node.className = className;
  node.setAttribute('aria-hidden', 'true');
  node.hidden = hidden;
  return node;
}

export function createComposer() {
  const attach = createButton({ symbol: 'plus', aria: 'Add photos or files', glass: false, size: 'small' });
  const mic = createButton({ symbol: 'mic.fill', aria: 'Dictate', glass: false, size: 'small' });
  attach.el.id = 'attach';
  mic.el.id = 'mic';
  for (const b of [attach, mic]) b.el.classList.add('composer-icon');

  const field = createField({
    look: 'glass',
    placeholder: 'Message',
    aria: 'Message',
    multiline: true, // Return is handled by the app (it depends on a setting)
    maxRows: 12,
    leading: [attach.el],
    trailing: [mic.el],
    onResize: () => layout(),
  });
  field.el.id = 'field';
  field.el.classList.add('composer-field');
  field.el.dataset.glass = 'control';
  field.input.id = 'input';
  field.input.setAttribute('enterkeyhint', 'send');
  field.input.setAttribute('autocomplete', 'off');

  const send = createButton({ aria: 'Agent', glass: 'control' });
  send.el.id = 'send';
  send.el.classList.add('composer-send');
  send.el.setAttribute('aria-haspopup', 'dialog');
  const agentIcon = span('agent-icon above');
  agentIcon.innerHTML = AGENT_FACE;
  const sendIcon = span('send-icon above', true);
  const sendGlyph = document.createElement('i');
  applySymbol(sendGlyph, 'arrow.up', { size: 18 });
  sendIcon.append(sendGlyph);
  const stopDisc = span('stop-disc above');
  const stopGlyph = document.createElement('i');
  applySymbol(stopGlyph, 'stop.fill', { size: 12 });
  stopDisc.append(stopGlyph);
  send.el.append(agentIcon, sendIcon, stopDisc);

  const attachments = document.createElement('div');
  attachments.className = 'attachments';
  attachments.id = 'attachments';

  let attached = false;
  const items = () => {
    // The natural height: the bar fixes the field's own box to the height it was given.
    const h = Math.max(44, field.input.offsetHeight || 44);
    const row = [
      { id: 'field', node: field.el, size: 'fill', height: h },
      { id: 'send', node: send.el, size: 44, height: 44, align: 'end' },
    ];
    return { main: [row], attach: [[{ id: 'attachments', node: attachments, size: 'fill', height: 84, glass: false }], row] };
  };
  const initial = items();
  // The field grows with its text (the bar then makes room for it).
  new ResizeObserver(() => layout()).observe(field.input);
  const bar = createBar({ edge: 'top', layouts: initial, layout: 'main', gap: 8, rowGap: 6 });

  function layout(animate = true) {
    const next = items();
    bar.setItems('main', next.main, { animate });
    bar.setItems('attach', next.attach, { animate });
  }

  return {
    bar,
    field,
    input: field.input,
    send,
    attach,
    mic,
    attachments,
    /** Shows the strip of attached files above the field (or hides it). */
    showAttachments(on) {
      on = !!on;
      if (on === attached) return;
      attached = on;
      bar.setLayout(on ? 'attach' : 'main');
    },
    layout,
    sendIcon,
    agentIcon,
  };
}
