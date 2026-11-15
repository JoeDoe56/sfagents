/**
 * The left edge of the chat: one dot per repository any agent can reach
 * (clean or not, active or not). It is the topic rail (rail.js), mirrored:
 * the same dots, the same pills, the same gestures and keyboard. Each pill
 * reads "repository  branch · status"; releasing on one (or clicking it)
 * opens its Git window, releasing anywhere else opens nothing.
 */

import { createRail } from './rail.js';

/** @param {{root: HTMLElement, dots: HTMLElement, list: HTMLElement, onOpen: (repo: object, from: HTMLElement) => void}} o */
export function createGitEdge(o) {
  const rail = createRail({ root: o.root, dots: o.dots, list: o.list, idPrefix: 'gitrail', onJump: (repo, row) => o.onOpen(repo, row ?? o.root) });
  return {
    set(repos) {
      rail.setSections(
        (Array.isArray(repos) ? repos : []).map((r) => ({
          ...r,
          title: r.name,
          detail: [r.branch, r.status].filter(Boolean).join(' · '),
          depth: 0,
          tone: r.unavailable ? 'off' : r.working?.length ? 'busy' : /conflict/i.test(r.status ?? '') ? 'conflict' : '',
        })),
      );
    },
    rail,
  };
}
