/**
 * Public API of @sfagents/core. The CLI uses only these exports.
 */

export * from './agents/definition.js';
export * from './agents/loader.js';
export { MessageAgentTool, toReplyPayload, MAX_AGENT_MESSAGE_CHARS, AGENT_MESSAGING_GUIDANCE, MESSAGE_USER_GUIDANCE, THREAD_MESSAGING_GUIDANCE, mailText } from './agents/message-agent.js';
export type { AgentReplyPayload, MessageAgentParams, AgentMessenger } from './agents/message-agent.js';
export { watchProject } from './agents/watch.js';
export { PROMPTS_DIR_NAME, PromptReferenceError, defaultPromptsDir, ensurePrompts, expandPrompt, isPromptReference } from './agents/prompts.js';
export { Mailbox, type MailItem } from './agents/mailbox.js';
export type { ProjectWatcher } from './agents/watch.js';
export { ThreadService, ThreadRecorder, ThreadBusyError, threadKey, threadPair, threadMessages, THREADS_DIR_NAME } from './agents/threads.js';
export type { ThreadInfo, ThreadLease } from './agents/threads.js';
export * from './runtime/events.js';
export { AgentRuntime, AgentSession, buildSystemPrompt, DEFAULT_MAX_TURNS } from './runtime/runtime.js';
export type { InboxItem, SendOptions } from './runtime/runtime.js';
export type { RuntimeOptions } from './runtime/runtime.js';
export * from './providers/types.js';
export { OpenAICompatibleProvider, OPENROUTER_BASE_URL, isOpenRouterHostname, mergeReasoningDetails } from './providers/openai-compatible.js';
export {
  createDefaultProviderFactory,
  credentialEnvNames,
  checkProviders,
  shouldFailOver,
  AccountState,
  FailoverProvider,
  MissingCredentialError,
  UnknownProviderError,
  NoProviderError,
  DEFAULT_MODELS,
  providerChoices,
  OPENROUTER_API_KEY_ENV,
} from './providers/factory.js';
export * from './providers/registry.js';
export { KeyringSecretStore, MemorySecretStore, KeyringUnavailableError, KEYRING_SERVICE } from './providers/secrets.js';
export type { SecretStore } from './providers/secrets.js';
export {
  CodexAppServer,
  CodexProvider,
  CodexSignIn,
  CodexRpcError,
  CODEX_CONFIG,
  CODEX_DISABLED_FEATURES,
  codexArgs,
  codexEnv,
  codexError,
  codexExecutable,
  codexPlanUsage,
  codexSignOut,
  defaultAnswer as codexDefaultAnswer,
  isAccountLimitStatus,
  toCodexItems,
} from './providers/codex.js';
export type { CodexConnection, CodexProviderOptions, CodexSignInResult } from './providers/codex.js';
export { PlanUsageStore, toPercent, toEpochMs } from './providers/usage.js';
export type { PlanUsage, UsageWindow } from './providers/usage.js';
export { ClaudeSignIn, ClaudeSubscriptionProvider, CLAUDE_MODELS, CLAUDE_MODEL_ALIASES, claudeExecutable, claudePlanUsage, findAuthUrl, prepareClaudeRequest } from './providers/claude-subscription.js';
export { sfagentsHome, writeFileAtomic, readJsonFile } from './settings/home.js';
export { AppSettings, SETTINGS, SettingsError, parseOrigin, parseSetting, settingSpec } from './settings/settings.js';
export type { SettingSpec, SettingValue } from './settings/settings.js';
export { HOTKEY_KEYS, HOTKEY_MODIFIERS, HOTKEY_OFF, formatHotkey, parseHotkey } from './settings/hotkey.js';
export type { Hotkey, HotkeyModifier } from './settings/hotkey.js';
export type { ProviderFactory } from './providers/factory.js';
export * from './mcp/config.js';
export { McpManager } from './mcp/manager.js';
export type { McpServerState, McpToolInfo, McpServerStatus } from './mcp/manager.js';
export { mcpFunctionName, transformMcpResult } from './mcp/mcp-tool.js';
export { WorkspaceContext } from './permissions/workspace.js';
export * from './tools/tools.js';
export { ToolErrorType } from './tools/tool-error.js';
export { ToolNames, BUILTIN_TOOL_IDS } from './tools/tool-names.js';
export { TOOL_SEARCH, AUTO_DEFER_MIN, ToolSearchTool, deferredToolNames, matchesToolPattern } from './tools/tool-search.js';
export { stripAnsiAndControl } from './utils/text-utils.js';
export { getErrorMessage } from './utils/errors.js';
export { openInBrowser } from './utils/open-url.js';
export { removeDir } from './utils/remove-dir.js';
export { descendantsOf, killProcessTree, parseProcessList, type ProcessEntry } from './utils/process-tree.js';
export * from './conversation/types.js';
export { parseConversation, serializeConversation, serializeRecord, decorationFor } from './conversation/format.js';
export { ConversationState, SemanticError } from './conversation/state.js';
export type { SectionState, RunState, ArtifactView } from './conversation/state.js';
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
export type {
  ArtifactContent,
  AttachmentResolver,
  CreateArtifactInput,
  OpenNotice,
  ReplayTarget,
  ServiceOptions,
  UpdateArtifactInput,
  LinkArtifactInput,
} from './conversation/service.js';
export { GENUI_DIR_NAME } from './conversation/service.js';
export { replayTarget } from './runtime/runtime.js';
export { PersistenceFailure } from './runtime/recorder.js';
export type { RunRecorder } from './runtime/recorder.js';
export type { ToolCallContext } from './tools/tools.js';
export {
  addSection,
  editSection,
  fetchSection,
  formatSearchResult,
  formatSectionPage,
  listSections,
  searchConversation,
  searchSections,
  sectionEntries,
  SectionOperationError,
  UNASSIGNED,
  CURRENT_EXCHANGE,
} from './conversation/sections.js';
export type { SectionEntry, SectionPage, SearchHit, SearchResult, FetchResult } from './conversation/sections.js';
export { createConversationTools, ConversationToolNames, ORGANIZE_GUIDANCE, SECTION_CHOICE_TOOLS, SECTION_REMINDER, MAX_SECTION_REMINDERS } from './conversation/tools.js';
export type { ConversationAccess } from './conversation/tools.js';
export { AGENT_REACTIONS, CHAT_GUIDANCE, ChatToolNames, chatEffects, createChatTools } from './conversation/chat-tools.js';
export {
  buildWorkingContext,
  contextBreakdown,
  ContextBudgetError,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_RECENT_EXCHANGES,
  estimateTokens,
  TURN_RESERVE,
} from './conversation/context.js';
export type { ContextPolicy, ContextReport, WorkingContext, ContextBreakdown, ContextTool } from './conversation/context.js';
export {
  ArtifactError,
  ArtifactToolNames,
  ARTIFACT_GUIDANCE,
  artifactIndex,
  artifactTypeFor,
  createArtifactTools,
  describeArtifact,
  isTextMime,
  MAX_ARTIFACT_CHARS,
  mimeForFilename,
  safeFilename,
} from './conversation/artifacts.js';
export type { ArtifactAccess } from './conversation/artifacts.js';
export {
  IMAGE_TOKEN_ESTIMATE,
  looksLikeText,
  MAX_INLINE_TEXT_BYTES,
  MAX_MODEL_IMAGE_BYTES,
  MODEL_IMAGE_TYPES,
  userMessageFor,
} from './conversation/attachments.js';
export { estimateMessages } from './conversation/context.js';
export { detectSandbox, setSandboxForTesting, accessFor, HOST_CHANNEL_ENV, SANDBOX_RUN_DIR } from './sandbox/sandbox.js';
export type { Sandbox, SandboxPolicy, SandboxRule, SandboxAccess, SandboxStatus, SandboxCommand, WrappedCommand } from './sandbox/sandbox.js';
export { buildSandboxPolicy, GIT_PROTECTED } from './sandbox/policy.js';
export { BubblewrapSandbox, bubblewrapCommand, findBubblewrap } from './sandbox/linux.js';
export { SeatbeltSandbox, seatbeltProfile } from './sandbox/macos.js';
export { WindowsSandbox, detectWindowsSandbox, windowsSandboxPath } from './sandbox/windows.js';
export { openHostChannel, webTools, SF_WEB_SCRIPT, DEFAULT_WEB_REQUESTS, MAX_WEB_RESULT_BYTES } from './sandbox/host-channel.js';
export type { HostChannel, WebGrant } from './sandbox/host-channel.js';
export { BrightDataWeb, BRIGHT_DATA_MCP_URL, WebAccessError } from './web/brightdata.js';
export type { WebAccess, WebOperation } from './web/brightdata.js';
