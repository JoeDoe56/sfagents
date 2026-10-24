/**
 * Windows: small floating windows that grow out of what was tapped (a stat
 * chip, a row) to a card near the top of the screen, with a title and an X.
 * Inside, a window can push views (a list → one item) with a back button;
 * the header morphs between the two layouts like any other bar.
 *
 * A window is a sheet of kind `window` (see sheet.js): the same springs, the
 * same glass, the same header and footer bars, the same gestures (drag the
 * header down to dismiss, tap outside, Escape), the same confirmation when
 * something is unsaved. It has one size, with a gap all round.
 *
 *   createWindow({source: chip, title: 'CPU', symbol: 'speedometer', build(ctx) {
 *     ctx.body.append(chart);
 *     ctx.every(1000, refresh);
 *     ctx.onLeave(() => chart.destroy());
 *   }});
 * @module
 */

import {el, icon} from './core.js';
import {createButton} from './button.js';
import {createSheet} from './sheet.js';

/**
 * @typedef {object} WindowView
 * @property {string} title
 * @property {string} [symbol]
 * @property {(ctx: WindowContext) => void} build
 *
 * @typedef {object} WindowContext
 * @property {HTMLElement} body
 * @property {HTMLElement} window
 * @property {(title: string) => void} setTitle
 * @property {(view: WindowView) => void} push
 * @property {() => void} pop
 * @property {() => void} close
 * @property {(ms: number, fn: () => unknown) => void} every   runs now and every `ms` after, until the view is left
 * @property {(fn: () => void) => void} onLeave
 */

/**
 * @param {{source?: Element | DOMRect, title: string, symbol?: string, build: (ctx: WindowContext) => void,
 *   onClose?: () => void, width?: number, height?: () => number}} o
 */
export function createWindow(o) {
  const closeBtn = createButton({symbol: 'xmark', aria: 'Close', size: 'large'});
  const backBtn = createButton({symbol: 'chevron.left', label: '', aria: 'Back'});
  const titleIcon = el('span', 'sf-window-title-icon');
  const titleText = el('span', 'sf-window-title-text', o.title);
  const titleNode = el('div', 'sf-sheet-title sf-window-title');
  titleNode.append(titleIcon, titleText);

  const layouts = {
    root: [[{id: 'close', node: closeBtn.el, size: 44, height: 48, into: 'back'}, {id: 'title', node: titleNode, size: 'fill', height: 48, glass: false}]],
    pushed: [[{id: 'back', node: backBtn.el, size: 128, height: 48, from: 'close'}, {id: 'title', node: titleNode, size: 'fill', height: 48, glass: false}]],
  };

  const sheet = createSheet({
    kind: 'window',
    source: o.source,
    header: {edge: 'top', layout: 'root', layouts},
    label: o.title,
    width: o.width,
    height: o.height,
    onClose: () => {
      for (const entry of stack) entry.stop();
      stack.length = 0;
      o.onClose?.();
    },
  });

  const stack = [];
  const viewport = el('div', 'sf-window-viewport');
  sheet.body.append(viewport);

  function setIcon(name) {
    titleIcon.replaceChildren();
    titleIcon.hidden = !name;
    if (name) titleIcon.append(icon(name, 15));
  }

  function makeView(view) {
    const body = el('div', 'sf-window-view');
    const timers = [];
    const leaves = [];
    const entry = {view, body, stop: () => [...timers, ...leaves].forEach((f) => f())};
    const ctx = {
      body,
      window: sheet.el,
      setTitle(t) {
        view.title = t;
        if (stack[stack.length - 1] === entry) titleText.textContent = t;
      },
      push: (next) => push(next),
      pop: () => pop(),
      close: () => sheet.close(),
      every(ms, fn) {
        let stopped = false;
        let timer = 0;
        const tick = async () => {
          if (stopped) return;
          try {
            await fn();
          } catch {
            // a failed refresh keeps the last content
          }
          if (!stopped) timer = setTimeout(tick, ms);
        };
        tick();
        timers.push(() => {
          stopped = true;
          clearTimeout(timer);
        });
      },
      onLeave: (fn) => leaves.push(fn),
    };
    view.build(ctx);
    return entry;
  }

  function show(entry, direction) {
    titleText.textContent = entry.view.title;
    setIcon(entry.view.symbol);
    const prev = stack[stack.length - 2];
    backBtn.setLabel?.(prev?.view.title ?? '');
    sheet.header.setLayout(stack.length > 1 ? 'pushed' : 'root');
    const old = viewport.querySelector('.sf-window-view.current');
    entry.body.classList.add('current');
    viewport.append(entry.body);
    if (old && direction) {
      const sign = direction === 'forward' ? 1 : -1;
      entry.body.animate([{transform: `translateX(${sign * 30}%)`, opacity: 0}, {transform: 'none', opacity: 1}], {duration: 320, easing: 'cubic-bezier(0.32, 0.72, 0, 1)'});
      const leaving = old.animate([{transform: 'none', opacity: 1}, {transform: `translateX(${-sign * 20}%)`, opacity: 0}], {duration: 260, easing: 'cubic-bezier(0.32, 0.72, 0, 1)'});
      leaving.onfinish = () => {
        if (!old.classList.contains('current')) old.remove();
      };
      old.classList.remove('current');
    } else if (old) old.remove();
  }

  function push(view) {
    const entry = makeView(view);
    stack.push(entry);
    show(entry, stack.length > 1 ? 'forward' : null);
  }

  function pop() {
    if (stack.length < 2) return;
    stack.pop().stop();
    show(stack[stack.length - 1], 'back');
  }

  backBtn.el.addEventListener('click', pop);
  push({title: o.title, symbol: o.symbol, build: o.build});
  sheet.present('window');

  return {
    sheet,
    push,
    pop,
    close: () => sheet.close(),
    setTitle: (t) => (titleText.textContent = t),
    get depth() {
      return stack.length;
    },
  };
}
