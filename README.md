# SF Agents

A small agent runtime and CLI. You define agents in JSON. Each agent talks to a model through OpenRouter (or any OpenAI-compatible endpoint), uses the built-in file, search and shell tools and the MCP tools it is allowed, and can delegate to the child agents it declares.

SF Agents started as an extraction of the minimal runtime from Qwen Code's `packages/core` and `packages/cli` (see [PROVENANCE.md](PROVENANCE.md)). It has a terminal interface and a web interface (`sfagents web`), one persistent conversation per project, and artifacts the agent creates for you to keep.

## Requirements

- Node.js 20.12 or newer (developed and tested on Node 22).
- An OpenRouter API key, or another OpenAI-compatible endpoint.

## Install

```sh
git clone https://github.com/JoeDoe56/sfagents
cd sfagents
npm install        # installs dependencies and builds (via the prepare script)
npx sfagents --help
```

`npm run build` rebuilds after changes. On any platform, `npm run sfagents -- <args>` also works.

## Configure the API key

Set `OPENROUTER_API_KEY` in your shell, or put it in an untracked `.env` file next to `agent.json`:

```sh
cp .env.example .env    # then edit .env
```

Keys never go in agent JSON. `.env` is git-ignored. Variables already set in the environment take precedence over `.env`.

## Commands

| Command | What it does |
| --- | --- |
| `sfagents start` | Opens (or creates) this project's persistent conversation and talks to the root agent. Streams answers, shows tool and child activity, asks before risky calls. Ctrl+C cancels the running turn; `/exit` or Ctrl+D quits; `/clear` resets the working context (history is kept); `/sections` shows the topic tree; `/tree` shows the agents. `--ephemeral` keeps the session in memory only. |
| `sfagents run "<task>"` | One request, ephemeral unless `--persist` (or `--conversation <file>`) records it in the conversation. The answer goes to stdout and activity to stderr. `-` reads the task from stdin. `--json` prints the structured result. Exit code: 0 done, 1 failed, 2 configuration error, 130 cancelled. |
| `sfagents web` | Serves the web interface at http://127.0.0.1:8093 (`--port`, `--host`). The same persistent conversation as `start`, with attachments, approvals in the page and the artifacts sheet. Ctrl+C stops it. See [Web interface](#web-interface). |
| `sfagents conversation …` | Inspects the stored conversation without opening it for writing: `info`, `sections`, `show <section\|unassigned\|message id>`, `search <words>`, `artifacts`. `unlock` removes a stale lock after confirmation. |
| `sfagents agents validate` | Validates every agent file and prints the tree with each agent's tools, auto-approvals and roots. |
| `sfagents mcp list` | Connects to each server in `mcp.json` and shows its status, tools and which agents may use it. |

Common options: `--config <dir|file>` (defaults to the current directory), `--mcp <file>`, `--yes` (approve every call that would ask), `--show-reasoning`, `--show-context` (one line per turn: estimated context size, recent exchanges sent, older ones left out), `--conversation <file>`, `--page N` (for `conversation` listings).

## Files

```text
agent.json                    root agent
agents/1-Subagent-Worker.json a child agent (name and number are for sorting only)
mcp.json                      named MCP servers (optional)
.env                          secrets (optional, untracked)
.sfagents/                    local conversation state (created by start; never committed)
  conversation.md             the persistent conversation: messages, sections, artifact references
  transcripts/<run>.md        one per child agent run
  artifacts/<id>/r<rev>/      every revision of each artifact the agent created
  uploads/                    files attached in the web interface (and partial uploads)
```

This repository ships a working example: a root agent with file tools and shell, a read-only `worker` child, and a demo MCP server. Run `npx sfagents agents validate` to see it.

## Agent definition

```json
{
  "id": "main",
  "description": "Shown to the parent when this agent is a child.",
  "provider": "openrouter",
  "model": "anthropic/claude-haiku-5.5",
  "systemPrompt": "You are the root agent.",
  "reasoning": "low",
  "temperature": 0.2,
  "maxOutputTokens": 4000,
  "workspace": { "roots": ["."] },
  "tools": {
    "allow": ["read_file", "write_file", "edit", "glob", "grep", "list_directory", "shell"],
    "mcpServers": ["local-tools", { "server": "github", "tools": ["search_issues"] }],
    "autoApprove": ["edit", "mcp__local-tools__*"]
  },
  "spawn": {
    "maxConcurrentChildren": 2,
    "maxDepth": 4,
    "children": ["agents/1-Subagent-Worker.json"]
  },
  "conversation": { "access": "organize" },
  "artifacts": { "access": "create" },
  "context": { "maxInputTokens": 48000, "recentExchanges": 12 },
  "limits": {
    "maxTurns": 40,
    "timeoutSeconds": 1800,
    "toolTimeoutSeconds": 600,
    "shellTimeoutSeconds": 120,
    "maxToolOutputChars": 30000
  }
}
```

| Field | Notes |
| --- | --- |
| `id` | Required. Unique in the tree. Starts with a letter; letters, digits, `_`, `-`. |
| `provider` | `openrouter`, or `openai-compatible` with `"providerOptions": { "baseUrl": "...", "apiKeyEnv": "MY_KEY_VAR" }`. |
| `model` | Any model ID the provider accepts. Nothing is hardcoded. |
| `reasoning` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Sent as OpenRouter's `reasoning.effort` (or `reasoning_effort` for other endpoints). Reasoning blocks are passed back across tool calls. |
| `workspace.roots` | Directories the file tools may touch, relative to this file. The root agent defaults to `["."]`. Children default to **no** filesystem access. |
| `tools.allow` | Built-in tools: `read_file`, `write_file`, `edit`, `glob`, `grep`, `list_directory`, `shell`. |
| `tools.mcpServers` | Server names from `mcp.json`, optionally limited to listed tools. |
| `tools.autoApprove` | Tools that skip the confirmation prompt. Built-in IDs, `mcp__<server>__<tool>` or `mcp__<server>__*`. |
| `spawn.children` | Child definition files, relative to this file, inside the configuration directory. Children use the same format and may have their own children. |
| `spawn.maxDepth` | Root only. Maximum tree depth (default 4). |
| `conversation.access` | Access to the persistent conversation's sections and history: `organize` (search, fetch, create and edit sections), `read` (search and fetch only) or `none`. Root defaults to `organize`; children default to `none` and may never exceed their parent. |
| `artifacts.access` | Artifacts: `create` (create, update, list and read), `read` (list and read) or `none`. Root defaults to `create`; children default to `none` and may never exceed their parent. |
| `context` | Root only. Working-context budget per request (estimated tokens) and how many recent exchanges to keep verbatim. Defaults are shown above. |
| `limits` | Turn budget and timeouts. Defaults are shown above. |

Unknown fields are errors, so a typo cannot silently change permissions. Every error names the file and field.

## Delegation

An agent with children gets one extra tool, `invoke_child`. It lists only that agent's direct children, by ID and description. A child runs in a fresh context with its own system prompt, model, tools, roots and limits. It receives only the task and the optional context its parent passes (at most 32,000 characters together), never the parent's conversation. The parent gets a structured JSON result:

```json
{ "agent": "worker", "status": "completed", "response": "…", "turns": 3,
  "toolCalls": { "read_file": { "ok": 2, "failed": 0 } }, "durationMs": 5210 }
```

`status` is `completed`, `error`, `max_turns`, `timeout` or `cancelled`. Children run one at a time in this version; `maxConcurrentChildren` is still enforced, so parallel execution can be added later without changing the semantics. Cancelling the root cancels the whole chain.

## Persistent conversation

`sfagents start` continues one ongoing conversation per project, stored in `.sfagents/conversation.md` next to `agent.json`. Close the CLI, come back tomorrow, and the agent still has the thread. The file is plain Markdown: opened in an editor or on GitHub it reads as a transcript, with metadata hidden in HTML comments. [docs/CONVERSATION-FORMAT.md](docs/CONVERSATION-FORMAT.md) specifies it.

- **Sections.** The root agent organizes the conversation into topics and subtopics with its section tools. New messages are filed under the current section automatically. Renaming or moving a section never changes the stored messages.
- **Working context.** Each request carries the system prompt, a bounded index of section titles, and the most recent complete exchanges that fit the budget. Older material stays stored; the agent fetches it with `search_conversation` or `fetch_section` when it becomes relevant. `--show-context` prints what each turn sent.
- **Children** run in fresh contexts. Each child run is stored in `transcripts/<run>.md` and linked from the parent conversation as an `agent_transcript` artifact. Children cannot see the main conversation unless their definition grants `conversation.access`.
- **One writer.** A second `start` on the same conversation gets an error naming the process that holds it. A lock left by a crashed process is replaced automatically when that process is provably gone; `sfagents conversation unlock` handles anything else.
- **Durability and crashes.** Every message, tool start and tool result is flushed to disk before the next step. After a crash, the next start reports interrupted runs and marks each unfinished tool call as either "never started" or "outcome unknown". Nothing is retried automatically, and the model is told which is which. A damaged ending is moved to `.sfagents/recovered/` and recorded, never silently dropped.
- **What is not restored.** "Always allow" approvals and `--yes` apply to the running process only. On resume, tools and permissions come from the current `agent.json`.
- **Privacy.** `.sfagents/` contains a `.gitignore` that excludes everything in it, and agent file tools cannot read or write it. Conversations can still contain anything you or your tools put in them, so treat the folder as private.

## Artifacts

Artifacts are things the agent makes for you to keep rather than say in a message: a document (`.md`), a self-contained web page (`.html`), an SVG drawing, a code or data file. The agent creates one with `create_artifact` (title, file name, content) and changes it with `update_artifact`, which writes a new revision and keeps the old ones. The file extension decides how it is shown. The agent sees an index of recent artifacts in its system prompt, and can `list_artifacts` and `read_artifact`.

Artifact content is stored under `.sfagents/artifacts/` and recorded in the conversation (`artifact`, `artifact_update` and `artifact_pin` records), so the list survives restarts. You pin artifacts in the web interface; `sfagents conversation artifacts` lists them with their latest revision and pins.

## Web interface

```sh
npx sfagents web            # http://127.0.0.1:8093
npx sfagents web --port 9000
```

The page is one conversation in the style of iMessage, with a bottom bar in the style of Apple Maps:

- **Messages** use iMessage's dark-mode bubble shapes and colours. Assistant replies render Markdown. Tool use appears as small grey lines ("Read src/app.ts"), and a typing bubble shows while the agent works.
- **The bar** holds the message field. **+** opens the file and photo picker (you can also drop or paste files), the microphone dictates where the browser supports it, and the circle on the right sends (or stops a running turn). The field grows with the text and then scrolls, as in iMessage. Return sends on a desktop (Shift+Return adds a line); this is a setting.
- **Swipe anywhere on the bar** (or tap the handle, or use the arrow keys on it) and it becomes a glass sheet; swipe further and it becomes an opaque sheet. Swipe down to close it; in the full sheet, pulling down at the top of the list closes it, as in Maps. Below the field: a placeholder for the system monitor, aligned with the field, and two round buttons under the send button: **Settings** (app settings for this device: glass quality and whether Return sends) and a placeholder. Then **Pinned** artifacts, a divider, and all artifacts, newest first, as glass tiles. Tap a tile to open it; the pin button pins or unpins it.
- **Approvals** appear as a card in the conversation (Allow Once, Always Allow, Don't Allow). `--yes` skips them.
- **Attachments** upload with an up2k-style protocol (after [copyparty](https://github.com/9001/copyparty)'s up2k): the browser hashes each chunk, the server asks only for chunks it does not have, chunks upload in parallel and are verified on arrival, an interrupted upload resumes (choose the same file again), and a file the server already has is not uploaded at all. Images are shown to the model; text files are included in the message; other files are named.

It is also a simple installable web app (manifest, icons, standalone display): use "Install" in Chrome or Edge, or Share → Add to Home Screen in Safari. Browsers only offer installation on a secure origin, which includes `localhost`/127.0.0.1 but not a plain-http LAN address.

The glass is [sfgl](https://github.com/JoeDoe56/sfgl) (vendored in `web/public/vendor/sfgl`; refresh it with `npm run vendor:sfgl -- <path to sfgl>`), and the font is Host Grotesk. Add `?quality=superfluid|glass|lite|frost|static` to the URL to force a glass quality tier.

Security: the server listens on 127.0.0.1 only, accepts only requests addressed to this host and port, and refuses cross-site writes. Artifacts and uploads are served in a sandbox, so a page the agent wrote cannot call the API. `--host 0.0.0.0` exposes the agent and its tools (with your permissions) to your network; there is no login.

## Permissions (enforced in code, not in prompts)

- **Tool allowlists** are checked when each call is executed. A model asking for a tool it was not given gets an error back; nothing runs.
- **File tools** resolve every path to its canonical real path (following `..` and symlinks, including for files that do not exist yet) and refuse anything outside the agent's roots. Agent and MCP configuration files are read-only to all file tools.
- **Child authority is a subset of the parent's.** Built-in tools, MCP servers and tools, auto-approvals and roots must each fit inside the parent's, or loading fails. The loaded tree is frozen.
- **Shell is root-only.** A path allowlist cannot confine arbitrary commands, and this version has no OS sandbox, so `shell` on any child is a configuration error. Shell commands run with your user's full permissions. Every command asks for approval unless you auto-approve `shell`.
- **Writes, edits, shell and MCP calls ask before running.** Exceptions: tools listed in `autoApprove`, MCP servers marked `"trust": true`, and the `--yes` flag. In `run` mode without a terminal, calls that need approval are denied and the model is told why.
- **MCP servers are not workspace-confined.** A server can reach anything its own process can. Grant servers per agent, preferably limited to specific tools.
- **Conversation state** (`.sfagents/`, including artifacts and uploads) is invisible to all file tools; it changes only through the conversation service and the web server.
- **Secrets:** the configuration directory's `.env` cannot be read, searched or written by any file tool (including through symlinks). Provider key variables are removed from the environment of shell commands and stdio MCP servers, and are never sent to the model. The root agent's approved shell commands could still read `.env`, so approve shell commands with care.

## MCP servers

```json
{
  "mcpServers": {
    "local-tools": { "command": "node", "args": ["server.js"], "cwd": ".", "env": { "TOKEN": "${MY_TOKEN}" }, "timeout": 30000 },
    "remote": { "httpUrl": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${REMOTE_TOKEN}" }, "includeTools": ["search"] }
  }
}
```

Transports: **stdio** (`command`) and **Streamable HTTP** (`httpUrl`). Legacy SSE is not supported. `${VAR}` values are read from the environment when the server connects; an undefined variable is an error rather than being sent literally. Server names may be at most 24 characters and must not contain `__`. The model sees tools as `mcp__<server>__<tool>`. A server connects the first time an agent that may use it starts a turn. Connection failures become warnings, and the agent continues without those tools. Failed tool calls are never retried automatically.

## Development

```sh
npm run build            # tsc project build (core, web, cli, tests)
npm test                 # build + deterministic tests (mock provider, local MCP servers)
npm run test:live        # live OpenRouter tests; needs OPENROUTER_API_KEY
npm run audit:imports    # static import / dependency audit
```

Set `SFAGENTS_LIVE_MODEL` to run the live tests against another model. Set `SFAGENTS_DEBUG=1` for debug logs on stderr. On Windows, `scripts/windows-smoke.ps1` runs the install, build, tests and a CLI smoke check.

```text
core/src/
  runtime/      agent loop, tool executor, events
  providers/    OpenAI-compatible provider, streamed tool-call parser
  agents/       JSON schema, tree loader, invoke_child
  tools/        built-in tools
  mcp/          mcp.json, connections, MCP tool wrapper
  permissions/  workspace containment
  conversation/ format, store, lock, sections, context builder, artifacts, attachments
web/src/        HTTP server, Server-Sent Events, up2k uploads, display model
web/public/     browser client (plain ES modules, no build step) and vendored sfgl
cli/src/
  entry/        commands and options
  config/       config location and .env
  terminal/     renderer, permission prompts, REPL
tests/          node:test suites and fixtures
```

Core has no terminal or web code; the CLI and the web server use only Core's public exports.

## Known limitations

- Children run sequentially; no live parent/child messaging.
- Search is lexical (all query words must appear); there is no semantic or embedding search yet, and no section summaries.
- Section deletion and merging are not supported yet.
- Token counts for the context budget are estimates (characters ÷ 4).
- If SF Agents itself is force-killed, a shell command it started keeps running; the next start reports that call's outcome as unknown.
- No OS sandbox, which is why `shell` is limited to the root agent.
- Model output is text only; MCP image and audio results are summarized, not shown to the model. Attached images are shown to the model (if it supports images); other binary attachments are only named.
- The web interface has one conversation, no login and no multi-user support. The system monitor and file manager in the sheet are placeholders.
- No MCP OAuth flow; use headers with environment variables.
- Windows: the first milestone was verified on Windows; the conversation features were developed and tested on Linux, and run their deterministic tests on Windows through `scripts/windows-smoke.ps1`.

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
