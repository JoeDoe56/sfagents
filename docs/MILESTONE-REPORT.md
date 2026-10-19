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

---

# Milestone 2: persistent conversation and semantic memory

**Date:** 2026-10-18 · **Plan:** [CONVERSATION-PLAN.md](CONVERSATION-PLAN.md), treated as direction rather than a checklist · **Format:** [CONVERSATION-FORMAT.md](CONVERSATION-FORMAT.md)

## Result

`sfagents start` now continues one persistent conversation per project. History, the section hierarchy and artifact references live in one Markdown file, `.sfagents/conversation.md`, which reads as a transcript when rendered. The root agent organizes topics and subtopics with its own tools. Each request carries a bounded working context: recent exchanges, a section index, and notes about what was left out. Older material is fetched on demand. Child runs are stored as linked transcripts. Crashes and kills are recovered conservatively, and nothing is retried automatically.

## What was built

| Area | Delivered |
| --- | --- |
| Format | Versioned, append-only records in HTML comments. Message bodies use boundary framing, so any Markdown, fences or look-alike markup is safe; tool output is fenced for readability; unknown fields are preserved. Readers diagnose errors with line numbers. |
| Store | Exclusive lock with stale-lock rules (dead local process or zombie: replaced; other host: never assumed); validate-then-append with `fsync` per record; external-change detection; stop-on-write-failure; damaged tails moved to `recovered/` with a `recovery` record. |
| Runtime | `RunRecorder` hooks at real message boundaries: user input before the request, run provenance, complete assistant messages (opaque reasoning blocks kept), tool start before execution, full tool results, run end. A storage failure stops the run before any further side effect. |
| Resume | Unfinished runs are marked `interrupted`, with each call classified as never-started or outcome-unknown (recursing into child transcripts). Synthetic, clearly labelled results keep the provider request valid but are never stored as observed results. Reasoning blocks are replayed only to the model that produced them. Approvals and authority come only from the current `agent.json`. |
| Sections | `list_sections`, `add_section`, `edit_section`, `search_sections`, `search_conversation`, `fetch_section`. Operations are atomic and revision-checked, cycle-safe, and never change message text or order. New messages follow the current section automatically. `conversation.access` grants: root `organize`, children `none` by default, never above the parent. |
| Context | A builder selects the newest complete exchanges within an estimated budget (`context.maxInputTokens` 48,000, `recentExchanges` 12, a quarter reserved for in-turn results) plus a bounded index that prioritizes the current section and its ancestors. Oversized input gets a clear error. `--show-context` reports each turn. |
| CLI | `start` persistent by default (`--ephemeral`, `--conversation`); `run` ephemeral unless `--persist`. `/clear` records a context reset; `/sections`. `conversation info\|sections\|show\|search\|artifacts\|unlock`. Signal handling without a TTY. |
| Isolation | `.sfagents/` is invisible to agent file tools and self-ignoring in Git. Children get only their task (plus a note mapping the parent's paths onto their own roots) and their own transcript. |

## Verification

| Plan acceptance check | Evidence |
| --- | --- |
| Round-trip, CRLF, Unicode, nested fences, delimiter-like content | `conversation-format` tests; reference fixture `tests/fixtures/conversation-v1.md` |
| Invalid references, duplicate IDs, cycles, newer versions, malformed and truncated records | `conversation-format`, `conversation-store` tests |
| Two processes, successive turns, fact remembered | CLI test with a mock provider; live test with Haiku 5.5 |
| Tool exchanges and reasoning payloads survive restart | Runtime test (exact replay; dropped for a different model); live cross-process test with signed Anthropic reasoning blocks |
| Crash before/after execution never repeats a tool; unknown outcomes explicit | Fault-injection tests at `tool_start` and at the tool result; CLI test that `SIGKILL`s a process mid-shell |
| Lock conflicts, stale locks, external edits, write failures, damaged tails | `conversation-store` and CLI lock tests |
| Child transcript survives restart and stays linked | Runtime test plus live demo |
| Ephemeral mode, one-shot tests, `/clear` | CLI and runtime tests |
| Topic operations survive reopen; invalid or stale edits fail without partial writes | `conversation-sections` tests (file size unchanged on failure) |
| Old fact retrieved by search/fetch while absent from the initial request | Deterministic test; live test with Haiku 5.5 |
| Bounded index and request on a large history | 2,000-exchange / 150-section test: 12 exchanges sent, index ≤ 60 entries, no unrelated bodies |
| Child retrieval needs an explicit grant | Grant tests (`none` sees no tools, `read` cannot organize, escalation rejected) |
| Indexes rebuildable from Markdown | No caches exist; search results are identical after reopening |
| Windows behavior | **Not run here** (Linux). All of the above are deterministic tests that run in `npm test`, which `scripts/windows-smoke.ps1` executes; that script also prints one manual Ctrl+C check for a real console. |

Totals: **126 deterministic tests** and **8 live tests** (Haiku 5.5) passing. Total live spend for this milestone: about $0.02.

### Live end-to-end demonstration (Haiku 5.5, pseudo-terminal)

1. Discussed a project ("KilnTime") and then an unrelated topic. The model created a project section, a pricing subsection under it, and a separate section for the new topic.
2. It ran a file tool and delegated a lookup to a child agent.
3. Closed and reopened: `Resumed … (16 messages)`.
4. Asked about the launch date and price. `--show-context` showed 2 recent exchanges sent and 2 older ones left out, plus the 3-section index. The model called `fetch_section s1` and answered correctly.
5. `conversation artifacts` listed the child transcript; its file holds the child's own run.
6. Killed the process during `sleep 60` and reopened: `interrupted: 1 tool call with unknown outcome (shell). Nothing was retried automatically.` The model told the user the outcome was unknown and did not re-run the command.

The demonstration found and fixed three issues: a child resolved a parent-relative path against its own root (child tasks now include a path mapping note); not-found errors lacked the resolved path; and a zombie process held a lock on Linux.

## Size

Core 9,632 lines (the conversation layer is 2,626 of them), CLI 1,152, tests 3,049. No new dependencies; `npm audit`: 0 vulnerabilities.

## Decisions taken within the plan

- Readable-transcript Markdown (chosen by the project owner). Topic structure is metadata (section operations), not headings, so reorganizing never moves messages.
- Child transcripts live in `transcripts/<run>.md` and are referenced as artifacts, keeping the main transcript readable. They share the main lock.
- Section tools are offered only for persistent conversations; one-shot `run` stays lean.
- Search is deterministic and lexical over the Markdown, with no index files.

## Known limitations

- Windows not yet verified for this milestone (see above).
- No semantic/embedding search, no section summaries, no section delete or merge (deferred by the plan).
- Token budgets are estimates (characters ÷ 4).
- Only `agent_transcript` artifacts are written by the runtime; there is no model tool to register document or media artifacts yet (the format already supports them).
- A force-killed SF Agents process cannot stop a shell command it started; the next start reports that call's outcome as unknown.
- PID reuse on the same host could make a stale lock look live; `conversation unlock` resolves it.
