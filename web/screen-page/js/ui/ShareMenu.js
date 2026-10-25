/*
 * SF Agents screen mirroring: a stand-in for a MoonlightWeb module SF Agents
 * leaves out. Copyright (C) 2026 SF Agents contributors. GPL-3.0-or-later.
 */

/** No session sharing in SF Agents. */
export class ShareMenu {
    async mount() {
        return false;
    }
    hasActiveShare() {
        return false;
    }
    destroy() {}
}
