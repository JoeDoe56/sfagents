/**
 * The row model: grouped rows as in iOS 26's Calendar. A section has a
 * title, a group (a 26 pt rounded card of rows with hairlines between), and
 * a note. A row has an optional icon, a title (and subtitle), and one thing
 * at its end: a value (with a dot, or the up-down chevrons of a menu), a
 * switch, chips, a check mark, a disclosure chevron, or a node of your own.
 * Rows can be anything else too: put your own node in a group.
 * @module
 */

import {el, icon} from './core.js';
import {showMenu} from './menu.js';

/**
 * @typedef {object} RowOptions
 * @property {string} [icon]                SF Symbol at the start
 * @property {string} [iconTint]            a colour: the icon sits in a rounded square of it, as in Settings
 * @property {string} [title]
 * @property {string} [subtitle]
 * @property {string} [value]               secondary text at the end
 * @property {string} [dot]                 a colour dot before the value (a calendar's colour)
 * @property {'menu'|'chevron'|'check'|'ellipsis'|'none'} [accessory]   `menu`: up-down chevrons after the value, `chevron`: disclosure, `check`: a check mark
 * @property {{checked: boolean, onChange?: (checked: boolean) => void}} [toggle]
 * @property {{value?: string, placeholder?: string, type?: string, inputMode?: string, autocomplete?: string, onInput?: (value: string) => void}} [input]   a text input at the end (the label on the left, the text right-aligned)
 * @property {Node} [leadingNode]         your own content before the text (a colour key)
 * @property {Node} [titleContent]        a node (highlighted text) in place of `title`
 * @property {Node} [subtitleContent]     likewise for the subtitle
 * @property {boolean} [tintTitle]          the title in the tint colour (an action row: Add Provider)
 * @property {{label: string, small?: string, onClick?: (anchor: HTMLElement) => void}[]} [chips]
 * @property {Node} [accessoryNode]         your own end content
 * @property {boolean} [destructive]
 * @property {boolean} [disabled]
 * @property {boolean} [center]             centred title (an action row)
 * @property {boolean} [wrap]               let the title wrap
 * @property {(anchor: HTMLElement, e: Event) => void} [onTap]
 * @property {{label: string, value?: any, symbol?: string, detail?: string}[]} [choices]   a dropdown: tapping the row opens a menu that grows out of the value
 * @property {any} [selected]               the chosen value of `choices`
 * @property {(value: any, choice: object) => void} [onChange]   a choice was made
 */

/** @param {RowOptions} o */
export function createRow(o = {}) {
  if (o.choices) {
    const picked = o.choices.find((c) => (c.value ?? c.label) === o.selected);
    o = {accessory: 'menu', value: picked?.label ?? o.value ?? '', ...o, onTap: () => openChoices()};
  }
  const interactive = !!(o.onTap || o.toggle);
  const node = el(o.input ? 'label' : o.onTap && !o.toggle ? 'button' : 'div', 'sf-row');
  if (node.tagName === 'BUTTON') node.type = 'button';
  if (interactive) node.classList.add('tappable');
  const state = {...o};
  let toggleNode = null;
  let valueNode = null;
  let titleNode = null;
  let subtitleNode = null;
  let checked = !!o.toggle?.checked;
  let inputNode = null;

  function build() {
    node.replaceChildren();
    node.classList.toggle('has-icon', !!state.icon);
    node.classList.toggle('destructive', !!state.destructive);
    node.classList.toggle('disabled', !!state.disabled);
    node.classList.toggle('center', !!state.center);
    node.classList.toggle('wrap', !!state.wrap);
    node.classList.toggle('tint-title', !!state.tintTitle);
    node.classList.toggle('has-input', !!state.input);
    if (state.icon) {
      const holder = el('span', `sf-row-icon${state.iconTint ? ' tinted' : ''}`);
      if (state.iconTint) holder.style.setProperty('--sf-tint', state.iconTint);
      holder.append(icon(state.icon, state.iconTint ? 17 : 18));
      node.append(holder);
    }
    if (state.leadingNode) {
      const lead = el('span', 'sf-row-lead');
      lead.append(state.leadingNode);
      node.append(lead);
    }
    const text = el('span', 'sf-row-text');
    titleNode = el('span', 'sf-row-title', state.titleContent ? '' : state.title ?? '');
    if (state.titleContent) titleNode.append(state.titleContent);
    text.append(titleNode);
    subtitleNode = null;
    if (state.subtitle || state.subtitleContent) {
      subtitleNode = el('span', 'sf-row-subtitle', state.subtitleContent ? '' : state.subtitle);
      if (state.subtitleContent) subtitleNode.append(state.subtitleContent);
      text.append(subtitleNode);
    }
    node.append(text);
    valueNode = null;
    if (state.chips?.length) {
      const chips = el('span', 'sf-chips');
      for (const c of state.chips) {
        const chip = el('button', 'sf-chip');
        chip.type = 'button';
        chip.append(document.createTextNode(c.label));
        if (c.small) chip.append(' ', el('small', '', c.small));
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          c.onClick?.(chip, e);
        });
        chips.append(chip);
      }
      node.append(chips);
    }
    if (state.value !== undefined || state.dot || state.accessory === 'menu') {
      valueNode = el('span', 'sf-row-value');
      if (state.dot) {
        const d = el('span', 'sf-dot');
        d.style.setProperty('--sf-tint', state.dot);
        valueNode.append(d);
      }
      if (state.value !== undefined) valueNode.append(el('span', '', state.value));
      if (state.accessory === 'menu') valueNode.append(icon('chevron.up.chevron.down', 13));
      node.append(valueNode);
    }
    inputNode = null;
    if (state.input) {
      inputNode = el('input', 'sf-row-input');
      const cfg = state.input;
      inputNode.type = cfg.type ?? 'text';
      inputNode.value = cfg.value ?? '';
      inputNode.placeholder = cfg.placeholder ?? '';
      inputNode.autocomplete = cfg.autocomplete ?? 'off';
      inputNode.spellcheck = false;
      inputNode.setAttribute('autocapitalize', 'off');
      inputNode.setAttribute('aria-label', state.title ?? '');
      if (cfg.inputMode) inputNode.inputMode = cfg.inputMode;
      inputNode.addEventListener('input', () => {
        cfg.value = inputNode.value;
        cfg.onInput?.(inputNode.value);
      });
      node.append(inputNode);
    }
    if (state.accessory === 'ellipsis') node.append(icon('ellipsis', 17));
    if (state.accessory === 'chevron') node.append(icon('chevron.right', 14));
    if (state.accessory === 'check') node.append(icon('checkmark', 16));
    if (state.toggle) {
      toggleNode = el('button', 'sf-toggle');
      toggleNode.type = 'button';
      toggleNode.setAttribute('role', 'switch');
      toggleNode.setAttribute('aria-checked', String(checked));
      toggleNode.setAttribute('aria-label', state.title ?? '');
      toggleNode.addEventListener('click', (e) => {
        e.stopPropagation();
        api.setChecked(!checked, true);
      });
      node.append(toggleNode);
    }
    if (state.accessoryNode) node.append(state.accessoryNode);
  }

  const api = {
    el: node,
    get anchor() {
      return valueNode ?? titleNode ?? node;
    },
    setTitle(t) {
      state.title = t;
      if (titleNode) titleNode.textContent = t;
    },
    setSubtitle(t) {
      state.subtitle = t;
      build();
    },
    /** The value text (and dot colour) shown at the end. */
    setValue(v, dot) {
      state.value = v;
      if (dot !== undefined) state.dot = dot;
      build();
    },
    setChecked(on, fromUser = false) {
      checked = !!on;
      toggleNode?.setAttribute('aria-checked', String(checked));
      if (fromUser) state.toggle?.onChange?.(checked);
    },
    get checked() {
      return checked;
    },
    /** The text input of an input row. */
    get input() {
      return inputNode;
    },
    setDisabled(on) {
      state.disabled = !!on;
      node.classList.toggle('disabled', !!on);
    },
    update(patch) {
      Object.assign(state, patch);
      build();
    },
  };
  function openChoices() {
    showMenu({
      source: api.anchor,
      placement: 'cover',
      align: 'end',
      items: state.choices.map((c) => ({
        label: c.label,
        symbol: c.symbol,
        detail: c.detail,
        checked: (c.value ?? c.label) === state.selected,
        action: () => {
          state.selected = c.value ?? c.label;
          api.setValue(c.label);
          state.onChange?.(c.value ?? c.label, c);
        },
      })),
    });
  }
  build();
  if (o.onTap) node.addEventListener('click', (e) => o.onTap(api.anchor, e));
  else if (o.toggle) node.addEventListener('click', () => api.setChecked(!checked, true));
  return api;
}

/**
 * A group: the rounded card of rows. Accepts row objects and your own nodes.
 * @param {(ReturnType<typeof createRow> | Node)[]} [children]
 * @param {{glass?: boolean}} [options]
 */
export function createGroup(children = [], options = {}) {
  const node = el('div', `sf-group${options.glass ? ' glass' : ''}`);
  node.setAttribute('role', 'group');
  const api = {
    el: node,
    add(...items) {
      for (const it of items) node.append(it.el ?? it);
      return api;
    },
    remove(item) {
      (item.el ?? item).remove();
      return api;
    },
    clear() {
      node.replaceChildren();
      return api;
    },
  };
  api.add(...children);
  return api;
}

/**
 * A section: a title, a group, a note.
 * @param {{title?: string, note?: string, rows?: (ReturnType<typeof createRow> | Node)[], group?: ReturnType<typeof createGroup>}} o
 */
export function createSection(o = {}) {
  const node = el('section', 'sf-section');
  const group = o.group ?? createGroup(o.rows ?? []);
  const api = {
    el: node,
    group,
    setTitle(t) {
      titleNode.textContent = t;
      titleNode.hidden = !t;
    },
    setNote(t) {
      noteNode.textContent = t;
      noteNode.hidden = !t;
    },
  };
  const titleNode = el('h3', 'sf-section-title', o.title ?? '');
  titleNode.hidden = !o.title;
  const noteNode = el('p', 'sf-section-note', o.note ?? '');
  noteNode.hidden = !o.note;
  node.append(titleNode, group.el, noteNode);
  return api;
}
