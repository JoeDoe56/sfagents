/**
 * Public API of @sfagents/core. The CLI uses only these exports.
 */

export * from './agents/definition.js';
export * from './agents/loader.js';
export * from './agents/editor.js';
export { MessageTool, MAX_QUESTION_OPTIONS, USER, toReplyPayload, MAX_AGENT_MESSAGE_CHARS, AGENT_MESSAGING_GUIDANCE, MESSAGE_USER_GUIDANCE, THREAD_MESSAGING_GUIDANCE, mailText, messageAction, MESSAGE_ACTIONS, USER_REACTIONS } from './agents/message-agent.js';
export type { MessageAction, MessageParams, MessageQuestion } from './agents/message-agent.js';
export type { AgentReplyPayload, AgentMessenger } from './agents/message-agent.js';
export { watchProject } from './agents/watch.js';
export { PROMPTS_DIR_NAME, PromptReferenceError, defaultPromptsDir, ensurePrompts, expandPrompt, isPromptReference } from './agents/prompts.js';
export { Mailbox, type MailItem } from './agents/mailbox.js';
export type { ProjectWatcher } from './agents/watch.js';
export { ThreadService, ThreadRecorder, ThreadBusyError, threadKey, threadPair, threadMessages, THREADS_DIR_NAME } from './agents/threads.js';
export type { ThreadInfo, ThreadLease } from './agents/threads.js';
export * from './runtime/events.js';
export { AgentRuntime, AgentSession, buildSystemPrompt, DEFAULT_MAX_TURNS, withStepContext } from './runtime/runtime.js';
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
export { mcpFunctionName, mcpApprovalKey, transformMcpResult } from './mcp/mcp-tool.js';
export { MCP_COMMAND, MCP_USAGE, mcpApprover, runMcpCommand, type McpGrant, type McpServerGrant } from './mcp/sfa-mcp.js';
export * from './tools/tools.js';
export { ToolErrorType } from './tools/tool-error.js';
export { ToolNames } from './tools/tool-names.js';
export { stripAnsiAndControl } from './utils/text-utils.js';
export { getErrorMessage } from './utils/errors.js';
export { openInBrowser } from './utils/open-url.js';
export { removeDir } from './utils/remove-dir.js';
export { descendantsOf, isLeftover, killProcessTree, orphansOf, parseProcessList, type ProcessEntry } from './utils/process-tree.js';
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
export type { RunRecorder, ViewSource } from './runtime/recorder.js';
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
export { ConversationActions, conversationActions, ORGANIZE_GUIDANCE, SECTION_CHOICE_HELP } from './conversation/tools.js';
export type { ConversationAccess } from './conversation/tools.js';
export { AGENT_REACTIONS, ChatToolNames, chatEffectOf, chatEffects } from './conversation/chat-tools.js';
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
  ARTIFACT_COMMAND,
  ARTIFACT_GUIDANCE,
  ARTIFACT_USAGE,
  artifactCommand,
  parseArtifactArgs,
  runArtifactRequest,
  artifactIndex,
  artifactTypeFor,
  describeArtifact,
  isTextMime,
  MAX_ARTIFACT_CHARS,
  mimeForFilename,
  safeFilename,
} from './conversation/artifacts.js';
export type { ArtifactAccess, ArtifactCommand, ArtifactRequest } from './conversation/artifacts.js';
export {
  GENUI_GUIDANCE,
  GENUI_VERSION,
  genuiStateSummary,
  MAX_GENUI_STATE_CHARS,
  parseGenui,
  validateGenui,
  writeGenuiState,
} from './conversation/genui.js';
export { availableHostCommands, DEFAULT_WEB_REQUESTS, HOST_COMMAND_NAMES, MAX_WEB_RESULT_BYTES, runHostCommand, WEB_COMMAND } from './tools/host-commands.js';
export type { HostCommandReply, HostCommands, WebGrant } from './tools/host-commands.js';
export {
  IMAGE_TOKEN_ESTIMATE,
  looksLikeText,
  MAX_INLINE_TEXT_BYTES,
  MAX_MODEL_IMAGE_BYTES,
  MODEL_IMAGE_TYPES,
  userMessageFor,
} from './conversation/attachments.js';
export { estimateMessages } from './conversation/context.js';
export { NetworkLog, networkLog, type NetworkLogEntry } from './container/network-log.js';
export { sfaPatch, sfaPatchScript, patchFormatFor, patchGuidance, SFA_PATCH_COMMAND, APPLY_PATCH_COMMAND, type PatchFormat } from './tools/sfa-patch.js';
export { GIT_IDENTITY_VARS, gitIdentityEnv } from './tools/shell.js';
export { BrightDataWeb, BRIGHT_DATA_MCP_URL, WebAccessError } from './web/brightdata.js';
export type { WebAccess, WebOperation } from './web/brightdata.js';
export { ContainerBridge, BridgeStream, encodeFrame, FrameReader, lazyDuplex, BRIDGE_CONTAINER, RUN_VOLUME } from './container/bridge.js';
export { ContainerManager, containerManager, setContainerManagerForTesting, containerIdFor, containerName, containerIdFromAppHost, rootMounts, hostToContainerPath, containerToHostPath, findSecretFiles, hostWorkspacesDir, agentImage, APP_HOST_SUFFIX, CONTAINER_COMMANDS, CONTAINER_CAPS, type AgentContainerSpec, type RootMount } from './container/containers.js';
export { CommandDockerCli, defaultDockerCli, docker, WSL_DISTRO, type DockerCli, type DockerResult } from './container/docker.js';
export { handleProxyConnection, levelAllows, isPrivateAddress, isNetworkLevel, networkLevelOf, NETWORK_LEVELS, NETWORK_LEVEL_TEXT, PACKAGE_HOSTS as CONTAINER_PACKAGE_HOSTS, GIT_HOSTS, HOST_CHANNEL_NAME, type NetworkLevel, type NetworkEvent } from './container/network.js';
export { BRIDGE_SOURCE, INIT_SOURCE, CLIENT_SOURCE, EXEC_SOURCE, KILL_SOURCE, FRAME } from './container/scripts.js';
export { wslStatus, setupDistro, mergeWslConfig, wslConfigPath, wslConfigSettings, writeWslMemoryCap, wslMemoryMb, mountRootsInDistro, WSLCONFIG_SETTINGS, type WslStatus } from './container/wsl.js';
export { GitWorkspaces, GitError, CHECKPOINT_PREFIX, TASK_BRANCH_PREFIX, CONTAINER_WORKSPACES_DIR, taskOfPath, repoNameOf, githubRepo, hostGitCredential, parsePatch, type GitRunner, type GitCredential, type TaskRecord, type RepoRecord, type WorkspaceInfo, type ReviewFile, type ReviewHunk } from './git/workspaces.js';
export { GIT_COMMAND, CI_COMMAND, GIT_USAGE, CI_USAGE, runGitCommand, runCiCommand, type GitGrant } from './git/sfa-git.js';
export { defaultGitWorkspaces } from './git/default.js';

export { GitHubPullRequests, githubApi } from './git/github.js';

export { FullControlManager, RollbackJournal, runHostShell, type FullControlPlan, type FullControlStatus } from './runtime/full-control.js';

export { UiService, ContainerUiAdapter, WindowsUiAdapter, runUiCommand, riskyControl, UI_COMMAND, UI_USAGE, type UiAdapter, type UiControl, type UiGrant, type UiReply } from './ui/ui.js';
export { StartLux, type UiDecider, type DecisionQuestion, type DecisionAnswer } from './ui/startlux.js';
