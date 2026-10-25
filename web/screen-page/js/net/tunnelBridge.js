/*
 * SF Agents screen mirroring: a stand-in for a MoonlightWeb module SF Agents
 * leaves out. Copyright (C) 2026 SF Agents contributors. GPL-3.0-or-later.
 */

/**
 * SF Agents serves the stream page itself: no tunnel through an introduction
 * server, the signaling socket goes straight to SF Agents (/api/screen/ws).
 */
export function openSignalingSocket(url) {
    return new WebSocket(url);
}
export function tunnelHostId() {
    return null;
}
export function pageCameThroughTunnel() {
    return false;
}
