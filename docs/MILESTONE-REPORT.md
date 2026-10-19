# Milestone report: initial core and CLI

**Date:** 2026-10-18 · **Upstream pin:** QwenLM/qwen-code@`97925919` (core and cli only)

## Result

`sfagents` starts from its own CLI, loads JSON agent definitions, talks to OpenRouter, runs built-in and MCP tools under enforced per-agent policy, delegates to declared child agents, and returns final answers. It builds from a clean checkout with `npm ci`, with no Qwen Code package, script, account or binary.

## Size

| | Upstream (non-test source files) | SF Agents source files | SF Agents lines |
| --- | --- | --- | --- |
| Core | ~987 | 36 | 6,650 |
| CLI | ~1,492 | 9 (+1 bin shim) | 870 |
| Tests | — | 8 suites + 1 MCP fixture | 1,848 |

Build output: `core/dist` 764 KB, `cli/dist` 160 KB.

## Dependencies retained

| Package | Direct dependencies |
| --- | --- |
| `@sfagents/core` | `openai`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `glob`, `jsonrepair`, `diff` |
| `@sfagents/cli` | `@sfagents/core` only (node `parseArgs` and `readline` replace yargs and Ink) |
| Dev (root) | `typescript`, `@types/node` (tests use the built-in `node:test`) |

About 135 packages install in production, most of them pulled in by the MCP SDK's own server-side dependencies (express, hono). `npm audit`: 0 vulnerabilities.

## User-facing commands

`sfagents start` · `sfagents run "<task>"` (`--json`, `-` for stdin) · `sfagents agents validate` · `sfagents mcp list`. Options: `--config`, `--mcp`, `--yes`, `--show-reasoning`.

## Protocols

- **Model:** OpenAI-compatible chat completions with streaming and tool calls. OpenRouter's `reasoning.effort` is sent, and `reasoning_details` are passed back across tool calls (verified live with signed Anthropic reasoning blocks).
- **MCP transports:** stdio and Streamable HTTP. Legacy SSE was deliberately not kept.

## Verification

| Plan test | Evidence |
| --- | --- |
| Clean Windows installation and build | **Not run.** This environment is Linux. `scripts/windows-smoke.ps1` is ready; Windows-specific code paths were reviewed against upstream but are unverified. |
| Clean install and build (Linux) | `npm ci` from a fresh copy builds and links `sfagents` |
| Static import audit | `npm run audit:imports` passes; a negative test proves it catches violations |
| Standalone cold start | No Qwen scripts, assets or account involved |
| Basic model request | Live (Haiku 5.5) via `sfagents run` |
| Tool-call loop | Mock provider tests + live `read_file` loop with reasoning |
| Shell policy | Allowed command, exit codes, timeouts, cwd containment, key stripping; shell on any child rejected at load |
| MCP stdio | Mock + live (`add` through the model loop) |
| MCP Streamable HTTP | Discovery and invocation, headers with `${VAR}`, auth failure |
| MCP permissions | Denied server never started or visible; per-tool grants; invocation of hidden tools rejected |
| Recursive agent JSON | Root, child and grandchild load; cycles, duplicates, outside paths, escalation rejected |
| Delegation | Structured child result; grandchild; live root → child with its own tool |
| Tool isolation | Child cannot use undeclared tools, MCP tools, files or children; frozen tree |
| Filesystem isolation | Absolute paths, `..`, symlink and dangling-symlink escapes, protected config, unreadable `.env` |
| Failure handling | Provider error, missing key, tool exception, MCP failures, timeouts, cancellation |
| Follow-up input | `start` keeps context (mock and live); interactive TTY session driven manually through a pseudo-terminal (approval prompt, Ctrl+C cancel) |

Totals: 83 deterministic tests and 5 live tests passing. Live spend for all verification was about $0.004.

## Known limitations

- Windows not yet verified (see above).
- Children run one at a time; `maxConcurrentChildren` is enforced but there is no parallel scheduling yet.
- No OS sandbox, so `shell` is root-only and runs with the user's permissions. An approved shell command can read anything the user can, including `.env`.
- Hard links inside a workspace root that point to outside files cannot be detected by path checks.
- MCP servers are not workspace-confined; MCP OAuth is not supported (use headers with environment variables).
- Image and audio results from MCP tools are summarized as text.
- Conversation context is in memory only.

## Process notes

- Milestones were committed in four groups rather than the plan's five separate commits. Core, CLI, JSON configuration, tools, MCP and delegation were built together before the first commit, because the runtime and the agent tree depend on each other. Each later commit builds and passes its tests.
- Upstream code was copied file by file into SF Agents rather than copying both packages whole and pruning, to keep about 2,500 deleted files out of the repository history. See `docs/INVENTORY.md`.
