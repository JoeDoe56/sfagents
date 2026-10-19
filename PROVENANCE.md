# Source provenance

SF Agents reuses code from **Qwen Code** `packages/core` and `packages/cli` only, under the Apache License 2.0.

- **Upstream:** https://github.com/QwenLM/qwen-code
- **Pinned commit:** `97925919acb92b089d817991bfefe4545601c8f6` (2026-10-18, package version 0.25.2)
- **Allowed source:** `packages/core`, `packages/cli`. Nothing is taken from any other Qwen Code package.
- Qwen Code was originally based on Google's Gemini CLI, so many upstream files carry a `Copyright 2025 Google LLC` header. Those headers are kept on every file derived from them.

The upstream code is not merged continuously. To take a later upstream fix, compare the listed upstream file at a newer commit and port the change by hand.

## Legend

| Status | Meaning |
| --- | --- |
| **Copied** | Upstream file with import paths changed only. |
| **Adapted** | Upstream file reduced or decoupled; the remaining logic is upstream's. |
| **Design-derived** | New SF Agents code that keeps upstream names, contracts or algorithms from the listed files, replacing a much larger upstream implementation. |
| **SF Agents** | New code with no upstream source. |

## core (`@sfagents/core`)

| File | Status | Upstream source (packages/core/src/…) |
| --- | --- | --- |
| `tools/edit-helper.ts` | Copied | `utils/editHelper.ts` |
| `providers/streaming-tool-call-parser.ts` | Copied | `core/openaiContentGenerator/streamingToolCallParser.ts` |
| `providers/tool-call-arguments.ts` | Copied | `core/tool-call-arguments.ts` |
| `utils/safe-json-parse.ts` | Copied | `utils/safeJsonParse.ts` |
| `tools/tools.ts` | Adapted | `tools/tools.ts` (invocation and declarative tool contract, `ToolResult`, `Kind`, confirmation details) |
| `tools/tool-error.ts` | Adapted | `utils/tool-error-type.ts`, `tools/tool-error.ts` |
| `tools/tool-names.ts` | Adapted | `tools/tool-names.ts` |
| `tools/read-file.ts` | Adapted | `tools/read-file.ts`, `utils/fileUtils.ts` (text path) |
| `tools/write-file.ts` | Adapted | `tools/write-file.ts` |
| `tools/edit.ts` | Adapted | `tools/edit.ts` (`applyReplacement`, `calculateEdit`) |
| `tools/glob.ts` | Adapted | `tools/glob.ts`, `tools/glob-search.ts` |
| `tools/grep.ts` | Adapted | `tools/grep.ts`, `utils/gitUtils.ts` (`NO_EXEC_CONFIG`) |
| `tools/ls.ts` | Adapted | `tools/ls.ts` |
| `tools/shell.ts` | Adapted | `tools/shell.ts`, `services/shellExecutionService.ts` (child_process path, process-tree kill), `utils/shell-utils.ts` (`getShellConfiguration`, Git Bash detection) |
| `permissions/workspace.ts` | Adapted | `utils/workspaceContext.ts` |
| `utils/schema-validator.ts` | Adapted | `utils/schemaValidator.ts` |
| `utils/text-utils.ts` | Adapted | `utils/textUtils.ts` |
| `utils/errors.ts` | Adapted | `utils/errors.ts` |
| `utils/child-env.ts` | Adapted | `utils/sanitize-child-env.ts`, `utils/windowsPath.ts` |
| `mcp/config.ts` | Adapted | `config/mcp-server-config.ts`, `utils/envVarResolver.ts` |
| `mcp/manager.ts` | Adapted | `tools/mcp-client.ts` (`createTransport`, `isEnabled`); replaces `tools/mcp-client-manager.ts` |
| `mcp/mcp-tool.ts` | Adapted | `tools/mcp-tool.ts` (`DiscoveredMCPTool`, result transformation) |
| `providers/openai-compatible.ts` | Design-derived | `core/openaiContentGenerator/*`, `provider/openrouter.ts`, `provider/default.ts` |
| `runtime/events.ts` | Design-derived | `core/turn.ts` (event concepts), `agents/runtime/agent-types.ts` (`AgentTerminateMode`) |
| `runtime/runtime.ts` | Design-derived | `agents/runtime/agent-core.ts` (`runReasoningLoop`) |
| `runtime/tool-executor.ts` | Design-derived | `core/coreToolScheduler.ts` (check order) |
| `agents/invoke-child.ts` | Design-derived | `tools/agent/agent.ts` |
| `utils/debug.ts` | Design-derived | `utils/debugLogger.ts` (call shape only) |
| `agents/definition.ts`, `agents/loader.ts`, `providers/types.ts`, `providers/factory.ts`, `tools/tool-context.ts`, `tools/file-io.ts`, `utils/semaphore.ts`, `index.ts` | SF Agents | none |

## cli (`@sfagents/cli`)

| File | Status | Upstream source (packages/cli/src/…) |
| --- | --- | --- |
| `utils/read-stdin.ts` | Adapted | `utils/readStdin.ts` |
| `utils/cleanup.ts` | Adapted | `utils/cleanup.ts` |
| `entry/main.ts`, `config/load.ts`, `terminal/*.ts`, `index.ts`, `bin/sfagents.js` | SF Agents | none (replace `cli.ts`, `gemini.tsx`, `nonInteractiveCli.ts`, `config/*` and the Ink UI) |

## Not taken from upstream

Tests, fixtures, build scripts, the workspace manifests and the documentation are SF Agents' own. Upstream's tests targeted removed behavior and the `Config` mock surface, so none were kept.

See [docs/INVENTORY.md](docs/INVENTORY.md) for the full keep/remove map and the reasoning behind each decision.
