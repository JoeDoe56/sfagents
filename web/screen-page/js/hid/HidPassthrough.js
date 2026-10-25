/*
 * SF Agents screen mirroring: a stand-in for a MoonlightWeb module SF Agents
 * leaves out. Copyright (C) 2026 SF Agents contributors. GPL-3.0-or-later.
 */

/** No HID passthrough (wheels, flight sticks) in SF Agents. */
export class HidPassthrough {
    static supported() {
        return false;
    }
    handleMessage() {}
    excludedKeys() {
        return [];
    }
    stop() {}
}
