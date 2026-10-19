# Phase 1 inventory: Qwen Code `packages/core` and `packages/cli`

**Upstream:** https://github.com/QwenLM/qwen-code
**Pinned commit:** `97925919acb92b089d817991bfefe4545601c8f6` (main, 2026-10-18), package version 0.25.2
**Allowed source:** `packages/core` and `packages/cli` only.

## 1. What upstream looks like at this commit

| Package | Non-test source files | Largest areas (files) |
| --- | --- | --- |
| `packages/core` | ~987 | utils 152, tools 111, core 95, agents 93, services 78, managed-runtime 58, omni 49, memory 45, telemetry 41, extension 33, hooks 31 |
| `packages/cli` | ~1,492 | ui (Ink/React) 640, serve 363, commands 185, utils 67, config 56, acp-integration 46 |

Key structural facts discovered while mapping imports:

- **One large strongly connected cluster.** Following only runtime (non-`import type`) imports, `tools/read-file.ts`, `tools/shell.ts`, `tools/edit.ts`, `tools/glob.ts`, `tools/mcp-client.ts`, `core/turn.ts`, `core/coreToolScheduler.ts` and `core/openaiContentGenerator/index.ts` each reach the same **~801-file** closure. The bridges are the `Config` god-object (`config/config.ts`), telemetry loggers (`telemetry/loggers.ts`, `telemetry/types.ts`), `tools/truncation.ts`, and `services/ssh-execution-environment.ts`.
- Leaf modules that are *not* in the cluster: `tools/tools.ts` (14 files), `tools/grep.ts` (24), `utils/editHelper.ts` (0 imports), `utils/textUtils.ts`, `utils/workspaceContext.ts`, `core/openaiContentGenerator/streamingToolCallParser.ts`, `utils/safeJsonParse.ts`, `core/tool-call-arguments.ts`, `utils/envVarResolver.ts`, `config/mcp-server-config.ts`.
- File sizes of the central runtime are very large: `coreToolScheduler.ts` 8,130 lines, `llm-chat.ts` 7,118, `client.ts` 6,154, `shell.ts` 5,891, `mcp-client-manager.ts` 3,369, `agent-core.ts` 3,179, `shellExecutionService.ts` 3,131, `mcp-client.ts` 2,751, `converter.ts` 2,559, `subagent-manager.ts` 2,499.
- The internal message lingua franca is `@google/genai` (`Content`, `Part`, `FunctionDeclaration`); OpenAI-compatible providers convert to and from it (`converter.ts`).

### Forbidden internal dependencies

| Where | Dependency | Usage count | Decision |
| --- | --- | --- | --- |
| core `devDependencies` + `prebuild` script | `@qwen-code/browser-use` | build-time | **Remove.** Browser use is out of scope. The `prebuild` hook is dropped with Qwen's build script. |
| cli | `@qwen-code/qwen-code-core` | 2,414 imports | **Replace** with `@sfagents/core`. |
| cli | `@qwen-code/acp-bridge` | 365 imports | **Remove** (ACP is out of scope). |
| cli | `@qwen-code/channel-*` (12 packages) | 61 imports | **Remove** (messaging channels are out of scope). |
| cli | `@qwen-code/sdk` | 13 imports | **Remove** (SDK integration is out of scope). |
| cli | `@qwen-code/web-templates` | 3 imports | **Remove** (web UI is out of scope). |
| cli | `@qwen-code/audio-capture` | 1 import | **Remove** (audio is out of scope). |
| both | `../../scripts/build_package.js`, `scripts/postinstall.js`, `check-i18n` | build | **Replace** with plain `tsc -b` scripts in the SF Agents root. |

## 2. Strategy decision: copy-and-cut, not copy-everything-then-delete

Copying both trees whole (about 114 MB of source and snapshots) into the SF Agents repository and pruning would put ~2,500 files into the repository's permanent history only to delete ~97% of them. Because the central runtime files are each several thousand lines tied to the `Config` cluster, almost none of them survive the milestone unmodified anyway.

So the isolation happens in a separate, untracked checkout of the pinned commit. Only the files and functions retained for this milestone are copied into SF Agents. Each copied file keeps its upstream license header and is listed in [PROVENANCE.md](../PROVENANCE.md). Where an upstream file is a 3,000 to 8,000 line orchestrator coupled to `Config`, SF Agents keeps the **upstream design and names** (event types, terminate modes, tool invocation contract, MCP config shape) but implements the reduced behavior in a small SF Agents-owned file instead of hollowing out the original. This follows plan rules 7 and 8.

## 3. Smallest runtime call path (upstream to SF Agents)

| Step | Upstream path | SF Agents |
| --- | --- | --- |
| CLI entry and flags | `cli/src/cli.ts` → `gemini.tsx` (yargs, Ink) / `nonInteractiveCli.ts` | `cli/src/entry/main.ts` (node `parseArgs`, no yargs), `terminal/repl.ts` (readline) |
| Settings and env | `cli/src/config/config.ts`, `config/environment.ts` (dotenv) | `cli/src/config/load.ts` (`process.loadEnvFile`, no dotenv) |
| Model client | `core/client.ts` → `llm-chat.ts` → `openaiContentGenerator/pipeline.ts` | `core/src/providers/openai-compatible.ts` (OpenAI chat format end to end, no genai conversion) |
| Streaming tool-call assembly | `openaiContentGenerator/streamingToolCallParser.ts` | copied, trimmed |
| Turn and events | `core/turn.ts` (`LlmEventType`, `ToolCallRequestInfo`, `ToolCallResponseInfo`) | `core/src/runtime/events.ts` (same concepts, typed SF events) |
| Tool scheduling | `core/coreToolScheduler.ts` (8,130 lines) | `core/src/runtime/tool-executor.ts` (authorize → confirm → execute → bound output) |
| Agent loop | `agents/runtime/agent-core.ts` `runReasoningLoop`, `AgentTerminateMode` | `core/src/runtime/agent-runner.ts` (same terminate modes) |
| Tools | `tools/tools.ts` base classes + individual tools | `core/src/tools/*` (adapted) |
| MCP | `tools/mcp-client.ts`, `tools/mcp-tool.ts`, `config/mcp-server-config.ts` | `core/src/mcp/*` (adapted, OAuth/Google auth removed) |
| Subagents | `subagents/subagent-manager.ts` (Markdown front-matter agents), `tools/agent/agent.ts` | `core/src/agents/*` + `invoke_child` tool (JSON tree, no front-matter format) |

## 4. Keep / decouple / remove map

Legend: **K** keep (copy with only renames), **D** keep but decouple or trim (substantially modified), **R** remove for this milestone, **S** replaced by a small SF Agents-owned implementation following the upstream design.

### packages/core

| Upstream file or area | Decision | Notes |
| --- | --- | --- |
| `tools/tools.ts` | D | Keep `ToolInvocation`, `BaseToolInvocation`, `DeclarativeTool`, `BaseDeclarativeTool`, `ToolResult`, `Kind`, confirmation detail types, `ToolConfirmationOutcome`. Drop media policy, artifacts, advisor, team, findings, MCP-app, terminal image and auto-classifier members. Schema type becomes plain JSON Schema instead of genai `FunctionDeclaration`. |
| `tools/tool-error.ts`, `utils/tool-error-type.ts` | D | Keep `ToolErrorType` (reduced to codes the retained tools emit). |
| `utils/schemaValidator.ts` (1,524 lines) | D | Keep Ajv draft-07 + draft-2020-12 selection and format handling; drop the compile-cache machinery and debug logger. |
| `utils/workspaceContext.ts` | D | Keep `WorkspaceContext`, `resolveWorkspacePath`, missing-path and symlink resolution, `isPathWithinRoot`. Drop change listeners and add/remove directories (roots are fixed per agent). Becomes `permissions/workspace.ts`. |
| `utils/editHelper.ts` | K | No imports; copied for fuzzy match, deletion and occurrence logic. |
| `utils/textUtils.ts` | D | Keep `safeLiteralReplace`, `isBinary`. |
| `tools/edit.ts` | D | Keep `applyReplacement` and the `calculateEdit` decision table (create, not found, 0 or many occurrences, no change), BOM and line-ending preservation. Drop prior-read cache, team-memory secret scanning, sandbox file versions, commit attribution, IDE diff. |
| `tools/write-file.ts` | D | Keep create/overwrite semantics, parent directory creation, line-ending preservation. Drop prior-read enforcement, artifacts and memory paths. |
| `tools/read-file.ts` + `utils/fileUtils.ts` | D | Keep offset/limit paging, binary detection, line truncation. Drop PDF, image, notebook and media handling. |
| `tools/glob.ts`, `tools/glob-search.ts` | D | Keep recency-then-alpha sorting, 100-file cap, de-duplication. Drop worker-thread execution and `.qwenignore`. |
| `tools/grep.ts` | D | Keep git grep → system grep → JavaScript fallback strategy and `--null` output parser. Add per-match canonical containment filtering. |
| `tools/ls.ts` | D | Keep directory listing with ignore globs, dirs-first sorting. |
| `tools/shell.ts`, `services/shellExecutionService.ts`, `utils/shell-utils.ts` | S + D | Keep `getShellConfiguration` (bash, cmd, PowerShell, Git Bash detection) and the process-group / `taskkill /t` cancel strategy. Replace the 9,000-line PTY/sandbox/SSH/background stack with a small `child_process` runner with timeout, bounded output and exit status. No node-pty. |
| `tools/mcp-client.ts` | D | Keep `createTransport` for stdio and Streamable HTTP (`httpUrl`), env inheritance with secret stripping, Windows PATH normalization, server-level `includeTools`/`excludeTools`. Drop OAuth, Google and service-account auth, legacy SSE (`url`; no existing configuration needs it and it would ship untested), SDK control transport, prompts, resources, MCP apps, version negotiation probing. |
| `tools/mcp-tool.ts` | D | Keep `DiscoveredMCPTool` result transformation (text, image/audio summaries, embedded resources, resource links, `structuredContent`, `isError`). Drop MCP apps, classifier input, progress, persisted output files. |
| `tools/mcp-client-manager.ts` | S | Replaced by a small `McpManager` (lazy connect, bounded timeouts, status, dispose). |
| `config/mcp-server-config.ts` | D | Keep the server shape (`command`, `args`, `env`, `cwd`, `httpUrl`, `headers`, `timeout`, `includeTools`, `excludeTools`, `trust`). Drop `url` (SSE), OAuth and auth provider fields. |
| `utils/envVarResolver.ts` | D | Keep `${VAR}` / `$VAR` expansion for `mcp.json`. |
| `utils/sanitize-child-env.ts` | D | Keep the idea: strip runtime secrets from child process env (provider API key variables). |
| `core/openaiContentGenerator/streamingToolCallParser.ts` | D | Keep streamed tool-call argument assembly. Depends on `utils/safeJsonParse.ts` (keep) and `core/tool-call-arguments.ts` (keep). |
| `core/openaiContentGenerator/provider/openrouter.ts`, `provider/default.ts` | D | Keep strict hostname check for OpenRouter and the OpenRouter `reasoning` parameter shape. Drop the other 10 provider adapters. |
| `core/openaiContentGenerator/pipeline.ts`, `converter.ts` | R | Unneeded once the internal format is OpenAI chat messages. |
| `core/turn.ts`, `core/client.ts`, `core/llm-chat.ts`, `core/geminiChat.ts` | S | Concepts kept (event types, tool call request/response info, finish reasons); implementation replaced. |
| `core/coreToolScheduler.ts`, `core/nonInteractiveToolExecutor.ts` | S | Replaced by `runtime/tool-executor.ts`. |
| `agents/runtime/agent-types.ts` | D | Keep `AgentTerminateMode`. |
| `agents/runtime/agent-core.ts`, `agent-headless.ts`, `agent-events.ts` | S | Loop, budget and event concepts kept; workflows, forks, arena, teams, skills, hooks removed. |
| `subagents/*` (Markdown front-matter agents, builtin agents) | R | Replaced by the SF Agents JSON tree (plan: do not preserve the older format). |
| `tools/agent/*` (agent tool, fork subagent) | S | Replaced by `invoke_child`. |
| `permissions/*` (rule parser, classifier, auto mode, shell semantics) | R/S | Replaced by explicit per-agent allowlists, workspace containment and a minimal confirmation policy. |
| `core/contentGenerator.ts`, `providers/*` (22 files), `models/*`, `qwen/*` | R | Qwen auth, presets, model discovery, Qwen OAuth. |
| `telemetry/*`, `services/*` (except as noted), `memory/*`, `hooks/*`, `skills/*`, `extension/*`, `lsp/*`, `ide/*`, `omni/*`, `goals/*`, `managed-runtime/*`, `sandbox/*`, `code-mode/*`, `mods/*`, `ipc/*`, `followup/*`, `board.ts`, `prompts/*`, `resources/*`, `confirmation-bus/*`, `output/*` | R | Outside milestone scope (plan section 5 table). |
| All other `tools/*` (cron, worktree, plan mode, todo, memory, web fetch/search, image gen, LSP, ask-user, team, task, monitor, notebook, exec, advisor) | R | Outside milestone scope. |
| Tests and snapshots | R | Upstream tests target removed behavior and the `Config` mock surface. SF Agents ships its own tests. |

### packages/cli

| Upstream file or area | Decision | Notes |
| --- | --- | --- |
| `ui/*` (Ink/React, 640 files) | R | Simple readline REPL instead. |
| `serve/*`, `acp-integration/*`, `peerMessaging/*`, `remoteInput/*`, `dualOutput/*`, `external-agents/*`, `agent-view/*` | R | Daemon, HTTP, ACP, channels, external agents. |
| `commands/*` (slash commands, extensions, MCP management UI) | R/S | `sfagents mcp list` and `agents validate` implemented directly. |
| `config/*` (settings, trust, sandbox, hooks, keybindings, auth) | S | Replaced by `config/load.ts`: config directory, `.env`, `agent.json`, `mcp.json`. |
| `nonInteractiveCli.ts` (3,531 lines) | S | Replaced by `sfagents run`. |
| `utils/readStdin.ts` | D | Keep piped-stdin read with an 8 MB cap for `run -`. |
| `utils/cleanup.ts` | D | Keep registered cleanup with per-step and overall timeouts (MCP disconnects on exit). |
| `i18n/*`, `services/*` (update checks, telemetry), `startup/*`, `patches/*` | R | Outside scope. |

## 5. Retained third-party dependencies

| Package | Why |
| --- | --- |
| `openai` | OpenAI-compatible chat completions client (OpenRouter). Upstream uses 5.x. |
| `@modelcontextprotocol/sdk` | MCP client and transports (stdio, Streamable HTTP). |
| `ajv`, `ajv-formats` | Tool argument validation (upstream `SchemaValidator`). |
| `glob` | Glob tool and grep fallback. |
| `jsonrepair` | Lenient parsing of streamed tool arguments (upstream `safeJsonParse`). |
| `diff` | Unified diffs in edit and write confirmation prompts. |
| Dev: `typescript`, `@types/node` | Build. Tests use Node's built-in `node:test` runner instead of upstream's vitest: vitest 3 carries open audit advisories and vitest 4.1 crashes npm 10's installer, while `node:test` adds no dependency. |

Removed relative to upstream core: `@google/genai`, `@anthropic-ai/sdk`, `@modelcontextprotocol/client` v2, all `@opentelemetry/*`, `google-auth-library`, `node-pty`, `sharp`, `web-tree-sitter`, `simple-git`, `undici`, `ws`, `yaml`, `zod` (only as the MCP SDK's own dependency), and roughly 40 others. Relative to upstream cli: `ink`, `react`, `yargs`, `express`, `dotenv`, `chalk`, markdown and highlighting libraries, `@a2a-js/sdk`, `@agentclientprotocol/sdk`.

## 6. Subagent reuse assessment

Upstream subagents are Markdown files with YAML front matter (`subagents/agent-frontmatter-schema.ts`), discovered from project and user directories, plus built-in agents. A single `agent` tool lists every discovered agent to the model, and children inherit a filtered copy of the parent `Config`. Reusable ideas: `AgentTerminateMode`, a separate chat per child, a tool allowlist per child, and returning a summarized result as the tool response. Not reusable: front-matter parsing and discovery, built-in Qwen agents and prompts, fork-subagent cache sharing, `Config` inheritance, workflows, teams and arena. SF Agents builds child contexts from the frozen JSON tree, so visibility comes only from the parent's declared `children`.
