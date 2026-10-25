/*
 * SF Agents screen mirroring. Copyright (C) 2026 SF Agents contributors.
 * GPL-3.0-or-later.
 */

/**
 * The stream page's own history. MoonlightWeb's app pushes a guard entry while
 * it streams and pops it with history.back() when the stream ends; in a frame,
 * the real history is the parent's too, so a Back there would take SF Agents'
 * own page back. This keeps the same calls inside the page instead: back()
 * pops the entry and calls the page's popstate handler, a moment later as a
 * browser would.
 */

const stack = [{ state: null }];
let onPop = null;

export const screenHistory = {
    get state() {
        return stack[stack.length - 1].state;
    },
    get length() {
        return stack.length;
    },
    pushState(state) {
        stack.push({ state });
    },
    replaceState(state) {
        stack[stack.length - 1] = { state };
    },
    back() {
        if (stack.length < 2) return;
        stack.pop();
        const state = this.state;
        setTimeout(() => onPop && onPop(state), 0);
    },
};

/** What the page does when an entry is popped. */
export function onScreenPopState(fn) {
    onPop = fn;
}
