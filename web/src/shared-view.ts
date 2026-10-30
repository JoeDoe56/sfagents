/**
 * What every page shows the same way, kept on the computer rather than in
 * each browser: the Files window's favorites, view, sort order and hidden
 * files. Stored as web-view.json in the conversation's state directory;
 * a change is sent to every open page.
 */

import path from 'node:path';
import { readJsonFile, writeFileAtomic } from '@sfagents/core';

export interface SharedView {
  files: {
    favorites?: string[];
    view?: 'list' | 'icons' | 'columns' | string;
    sort?: { key: string; desc: boolean };
    hidden?: boolean;
  };
}

function clean(input: unknown): SharedView['files'] {
  const out: SharedView['files'] = {};
  if (!input || typeof input !== 'object') return out;
  const v = input as Record<string, unknown>;
  if (Array.isArray(v.favorites)) out.favorites = v.favorites.filter((f): f is string => typeof f === 'string' && f.length < 4096).slice(0, 200);
  if (typeof v.view === 'string' && /^[a-z]{1,20}$/.test(v.view)) out.view = v.view;
  if (v.sort && typeof v.sort === 'object' && typeof (v.sort as { key?: unknown }).key === 'string') {
    const s = v.sort as { key: string; desc?: unknown };
    if (/^[a-z]{1,20}$/.test(s.key)) out.sort = { key: s.key, desc: s.desc === true };
  }
  if (typeof v.hidden === 'boolean') out.hidden = v.hidden;
  return out;
}

export class SharedViewStore {
  private readonly file: string;
  private value: SharedView;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'web-view.json');
    const raw = readJsonFile<Record<string, unknown>>(this.file, {});
    this.value = { files: clean(raw.files) };
  }

  get(): SharedView {
    return { files: { ...this.value.files } };
  }

  /** Merges the given parts (unknown or invalid ones are ignored). */
  update(patch: unknown): SharedView {
    const files = patch && typeof patch === 'object' ? clean((patch as { files?: unknown }).files) : {};
    this.value = { files: { ...this.value.files, ...files } };
    writeFileAtomic(this.file, `${JSON.stringify(this.value, null, 2)}\n`);
    return this.get();
  }
}
