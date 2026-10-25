/*
 * SF Agents screen mirroring: a stand-in for a MoonlightWeb module SF Agents
 * leaves out. Copyright (C) 2026 SF Agents contributors. GPL-3.0-or-later.
 */

/** No PyroWave player in SF Agents: streams are H.264, HEVC or AV1. */
export function ultraPlayerSupported() {
    return false;
}
export function presentMode() {
    return null;
}
export class UltraPlayer {
    constructor() {
        throw new Error('PyroWave is not part of SF Agents');
    }
}
