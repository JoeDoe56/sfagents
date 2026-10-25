/*
 * SF Agents screen mirroring: a stand-in for a MoonlightWeb module SF Agents
 * leaves out. Copyright (C) 2026 SF Agents contributors. GPL-3.0-or-later.
 */

/** No support button in SF Agents. */
export const SUPPORT_CHANGED_EVENT = "mw-support-changed";
export function showSupportButton() {
    return false;
}
export function openSupportPage() {}
export function noteGoodSession() {}
export function takeSupportIntroduction() {
    return false;
}
