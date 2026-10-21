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

---

# Milestone 3: web interface, artifacts and uploads

**Date:** 2026-10-19

## Result

`sfagents web` serves a browser interface on http://127.0.0.1:8093 for the same persistent conversation as `sfagents start`. The conversation looks like iMessage. The bottom bar is an Apple Maps-style pill: it pulls up into a glass sheet and then an opaque sheet that holds the artifacts. Agents can now create and revise artifacts, and users can attach files, which upload through an up2k-style resumable, deduplicating protocol.

## What was built

| Area | Delivered |
| --- | --- |
| Artifacts (Core) | `create_artifact`, `update_artifact`, `list_artifacts`, `read_artifact`, granted by the new `artifacts.access` field (root `create`, children `none`, no escalation). Every revision is kept under `.sfagents/artifacts/<id>/r<rev>/`. New `artifact_update` and `artifact_pin` records; an index of recent artifacts and short guidance go into the system prompt. `conversation artifacts` shows revisions and pins. |
| Attachments (Core) | User messages reference uploaded files. Images go to the model as image parts, text files are inlined, other files are named. Image parts are budgeted at a fixed estimate. |
| Web server (`web/`) | Node `http` only, no new dependencies. Serves the client, streams runs over Server-Sent Events (user message, text deltas, tool activity, approvals, artifact changes, run end), and handles cancel, approvals in the page, pins and sandboxed artifact and upload serving. Host-header and same-origin checks, JSON-only writes, and a CSP sandbox on everything the agent or the user supplied. Listens on 127.0.0.1 by default. |
| Uploads | An independent implementation of copyparty's up2k ideas: chunk size rule, SHA-512/33-byte base64url chunk hashes, salted "wark" identity, handshake returning needed chunks, parallel and stitched chunk posts verified on arrival and written straight into a sparse file, resume across reloads and server restarts, instant deduplication, size limit, stale partial cleanup. The browser hashes with `crypto.subtle` (or a bundled SHA-512 where that is unavailable), uploads four requests at a time with retries and shows progress rings. |
| Client | Plain ES modules, no build step. iMessage bubbles (colours sampled and the tail traced from the supplied screenshots, compared side by side at 3×), grouping with tails on the last bubble, time stamps, typing bubble, Markdown in replies, image and file attachments. The field grows like iMessage's and then scrolls. The bar has the sfgl plus icon (file and media picker, plus drop and paste), the mic (dictation where supported) and the right circle (blank glass; with text its glass fades to iMessage blue and the arrow comes in with sfgl's content transition; stop while running). A grabber drives a continuous three-detent sheet: collapsed pill, medium glass sheet, full opaque sheet, with drag, flick, tap and keyboard control. Below the field: the resource monitor (`GET /api/system`: Libre Hardware Monitor's web server when it runs, with the sensor names and units taken from its source; otherwise /proc and /sys on Linux, vm_stat, netstat and ioreg on macOS, nvidia-smi where installed; statfs for drives; numbers change with sfgl's content transition; drive bars scroll sideways past three), Pinned with a pin icon, a divider, then all artifacts newest first as equal glass squares with previews; a viewer opens documents, code, images and sandboxed pages. |
| Glass | sfgl, vendored by `scripts/vendor-sfgl.mjs` (sources, Host Grotesk, licenses and only the 33 SF Symbols used). sfgl refracts a texture, so the visible chat is repainted into a backdrop canvas (bubbles, words, images; cached per element, so scrolling only repaints). The opaque sheet is painted into that backdrop so the glass keeps its rim. Rims are a one-pixel hairline calibrated against iOS at 3x, and take the hue of whatever is just outside each stretch of the edge (a blue bubble next to the bar tints that part of the rim blue), as Liquid Glass does. CSS tiers get a real fill. |

## Verification

| Check | Evidence |
| --- | --- |
| Artifact storage, revisions, pins, reopen, malformed records, file-name sanitizing, tool grants and escalation, file tools cannot reach artifacts | `artifacts` tests (9) |
| Attachments to the model (image part, inlined text, named binary), replay after reopen, image token estimate | `artifacts` tests |
| up2k: chunk rule, parallel out-of-order chunks, hash mismatch, wrong length, unknown upload, non-consecutive stitching, resume after a server restart, byte-identical reassembly, deduplication, zero-byte file, size limit; client SHA-512 and chunk size identical to the server's | `web` tests |
| Server: CSP, foreign Host, cross-origin and non-JSON writes refused; SSE stream of a run that creates an artifact; busy rejection; sandboxed artifact serving; pins; attachments reach the model and are served back; approvals allow and deny; cancel | `web` tests |
| `sfagents web --port 0` serves, holds the conversation lock, stops on SIGINT with exit 0 and releases the lock; bad port and `--ephemeral` rejected | `web` CLI tests |
| Layout and behaviour | Headless Chromium at phone (430×932) and desktop (1280×800) sizes, in the `superfluid` and `frost` tiers: bubbles against the reference screenshot, growing field, drag and snap between detents, approvals, uploads with progress and instant dedupe, pinning, viewer |
| Live | `sfagents web` with Haiku 5.5 through the browser: described an attached image correctly, created a Markdown checklist and an SVG artifact (both shown as tiles with previews), streamed a Markdown reply |

Totals: **147 deterministic tests** passing; import audit and `npm audit` clean.

## Found and fixed while testing

- Focusing an element made the fixed stage scroll programmatically, which shifted the glass against the page; the stage and sheet now use `overflow: clip`.
- Reconnecting during a run showed a tool call twice; snapshots now hide the live run's stored messages.
- Replaced thread and tile nodes were left in the page during streaming; reconciliation now removes them.
- The tail's top edge left a hairline notch; the mask now starts above the corner.

## Known limitations

- Not yet tried on a real iPad or Windows browser. On iOS the stage follows the visual viewport (offset and height) when the keyboard opens, and sfgl places lenses relative to its canvas' real position, which fixed the glass jumping away from the bar in the first iPhone recording; the fix is checked in Chromium with a simulated visual viewport, not yet on the phone.
- Headless testing used SwiftShader, so glass performance on real GPUs is unmeasured. sfgl lowers its tier automatically when frames are slow.
- One conversation, no login. `--host` other than localhost exposes the agent to the network.
- The model-slug gradient is not started. The Windows paths of the process list, services, startup items and the Recycle Bin are written against PowerShell and .NET APIs but have not been run on Windows yet.
- Dictation uses the browser's Web Speech API (Chrome, Safari); Firefox shows the mic as unavailable.
- SF Symbols are Apple's artwork (see `web/public/vendor/sfgl/symbols/PROVENANCE.md`).

# Agents folder and threads between agents

## Result

Agents are now peers rather than a tree. Every valid `.json` file in `agents/` is an agent named by its file; invalid files are skipped with their reason. The conversation stays one thread for the user, and which agent replies to it is chosen separately (`--agent`, `/agent`, the agent menu on the web). Agents message each other with `message_agent` in persistent per-pair threads, in parallel, each with exactly its own permissions.

## What was built

| Area | Delivered |
| --- | --- |
| Loader | `agents/` folder; file stem is the identity, optional `name`; `spawn` rejected with a migration message; grants `"N-name.json"` in `tools.allow` (N = parallel threads, 1–999), any graph including cycles; no escalation rules; roots relative to the project; `main` replies by default. |
| Threads | `ThreadService`: `threads/<a>--<b>[--N].md` (kind `thread`), one per pair whoever writes; parallel instances; deadlock refusal when a replier would wait on its writer; replay with the other agent as user turns and the agent's own words as assistant turns. |
| `message_agent` | Enum of granted agents, message, optional thread; guidance for terse, structured agent-to-agent writing; parallel execution of calls in one turn; structured reply payload. |
| CLI | `--agent/-a`, `/agent <name>`, validate prints every agent and skipped files. |
| Web | `GET /api/agents`, `GET /api/threads[/key]`, `POST /api/agent {agent, reasoning}`, reasoning kept per agent. Agent sheet: Calendar-style pop-up button and menu of agents, staged changes saved with the check button. Chat: links to threads (opened as conversations in a sheet, live), artifact cards with previews that open in Quick Look. |

## Verification

| Check | Evidence |
| --- | --- |
| Folder loading, names, grants, skipping, selection | `config` tests |
| Messaging with the replier's own (wider) tools; one thread per pair across selection changes; three replies running at once; deadlock and ungranted refusals | `threads` tests |
| Thread files and artifact link survive a restart; the writer's context holds only the reply | `conversation-persistence` tests |
| Agent menu, staging, X discards, check saves, gradient follows the agent; thread sheet; artifact card to Quick Look | Headless Chromium at phone size against a scripted three-agent project |
