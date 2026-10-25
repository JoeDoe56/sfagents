/*
 * SF Agents screen mirroring: a stand-in for a MoonlightWeb module SF Agents
 * leaves out. Copyright (C) 2026 SF Agents contributors. GPL-3.0-or-later.
 */

/** No client log upload: the browser console keeps it. */
export const serverDiag = { debug: false, verbose: false };
export async function flushClientLog() {}
export async function refreshClientLog() {}
