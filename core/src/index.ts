/**
 * Public API of @sfagents/core. The CLI uses only these exports.
 */

export * from './agents/definition.js';
export * from './agents/loader.js';
export { InvokeChildTool, toChildPayload, MAX_CHILD_INPUT_CHARS } from './agents/invoke-child.js';
export type { ChildResultPayload, InvokeChildParams } from './agents/invoke-child.js';
export * from './runtime/events.js';
export { AgentRuntime, AgentSession, buildSystemPrompt, DEFAULT_MAX_TURNS } from './runtime/runtime.js';
export type { RuntimeOptions } from './runtime/runtime.js';
export * from './providers/types.js';
export { OpenAICompatibleProvider, OPENROUTER_BASE_URL, isOpenRouterHostname, mergeReasoningDetails } from './providers/openai-compatible.js';
export {
  createDefaultProviderFactory,
  credentialEnvNames,
  MissingCredentialError,
  OPENROUTER_API_KEY_ENV,
} from './providers/factory.js';
export type { ProviderFactory } from './providers/factory.js';
export * from './mcp/config.js';
export { McpManager } from './mcp/manager.js';
export type { McpServerState, McpToolInfo, McpServerStatus } from './mcp/manager.js';
export { mcpFunctionName, transformMcpResult } from './mcp/mcp-tool.js';
export { WorkspaceContext } from './permissions/workspace.js';
export * from './tools/tools.js';
export { ToolErrorType } from './tools/tool-error.js';
export { ToolNames, BUILTIN_TOOL_IDS } from './tools/tool-names.js';
export { stripAnsiAndControl } from './utils/text-utils.js';
export { getErrorMessage } from './utils/errors.js';
export * from './conversation/types.js';
export { parseConversation, serializeConversation, serializeRecord, decorationFor } from './conversation/format.js';
export { ConversationState, SemanticError } from './conversation/state.js';
export type { SectionState, RunState } from './conversation/state.js';
export {
  FileConversationStore,
  MemoryConversationStore,
  ConversationStorageError,
  InvalidOperationError,
  readConversation,
} from './conversation/store.js';
export type { ConversationStore, HeaderInfo, OpenReport, StoreIO } from './conversation/store.js';
export { ConversationLock, ConversationLockedError, forceUnlock, readLock } from './conversation/lock.js';
export type { LockInfo } from './conversation/lock.js';
export {
  ConversationService,
  defaultConversationFile,
  STATE_DIR_NAME,
  CONVERSATION_FILE_NAME,
  toChatMessages,
  INTERRUPTED_NOT_STARTED,
  INTERRUPTED_UNKNOWN,
} from './conversation/service.js';
export type { OpenNotice, ReplayTarget, ServiceOptions } from './conversation/service.js';
export { replayTarget } from './runtime/runtime.js';
export { PersistenceFailure } from './runtime/recorder.js';
export type { RunRecorder } from './runtime/recorder.js';
export type { ToolCallContext } from './tools/tools.js';
