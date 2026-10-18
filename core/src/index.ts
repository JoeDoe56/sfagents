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
