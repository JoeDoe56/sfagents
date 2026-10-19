/**
 * Public API of @sfagents/web: the web server behind `sfagents web`.
 */

export { WebServer, DEFAULT_HOST, DEFAULT_PORT, PUBLIC_DIR } from './server.js';
export type { WebServerOptions } from './server.js';
export { Up2kStore, Up2kError, up2kChunkSize, chunkHash, DEFAULT_MAX_UPLOAD_BYTES } from './up2k.js';
export type { HandshakeRequest, HandshakeResponse } from './up2k.js';
export { describeCall, displayItems, displaySections } from './display.js';
export type { DisplayItem, DisplayArtifact, DisplayApproval, DisplayAttachment, DisplaySection } from './display.js';
