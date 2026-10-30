# SF Agents

A small agent runtime and CLI. You define agents in JSON. Each agent talks to a model through a provider you add once (an OpenRouter key, your ChatGPT or Claude plan, or any OpenAI-compatible endpoint such as llama.cpp), uses the built-in file, search and shell tools and the MCP tools it is allowed, and can message the other agents it is granted, in persistent threads, in parallel.

SF Agents started as an extraction of the minimal runtime from Qwen Code's `packages/core` and `packages/cli` (see [PROVENANCE.md](PROVENANCE.md)). It has a terminal interface and a web interface (`sfagents web`), one persistent conversation per project, and artifacts the agent creates for you to keep.

## Requirements

- Node.js 20.12 or newer (developed and tested on Node 22).
- A model provider: an OpenRouter API key, a ChatGPT plan, a Claude plan, or an OpenAI-compatible endpoint.
- An operating-system keyring for provider keys and sign-ins: Windows Credential Manager and the macOS Keychain are built in; on Linux, a Secret Service (GNOME Keyring, KWallet or KeePassXC). Without one, providers can't be added (environment-variable keys still work).
- The terminal uses node-pty: Windows and macOS get prebuilt binaries; on Linux `npm install` compiles it (needs `make`, a C++ compiler and Python).

## Install

```sh
git clone https://github.com/JoeDoe56/sfagents
cd sfagents
npm install        # installs dependencies and builds (via the prepare script)
cp -R examples/agents agents
cp examples/mcp.json mcp.json
npx sfagents --help
```

The copy commands above are for a new checkout and also work in PowerShell. Skip them if you already have your own `agents/` folder and `mcp.json`. They are optional: `sfagents web` (and `start`) creates a missing `agents/` folder with a default `main.json` that names no provider, so it replies with the provider you add in Settings. A broken agent file or `mcp.json` never stops the app: it is skipped and flagged, and if no agent file loads at all, the built-in default agent replies until one is fixed. These local configuration files are ignored by Git; edit them freely without publishing your setup. Generic defaults stay in `examples/`.

`npm run build` rebuilds after changes. On any platform, `npm run sfagents -- <args>` also works.

## Providers and settings

Add providers in the web interface (**Settings → Providers → Add Provider**) or the terminal (`sfagents providers add …`). Each gets a name you choose, and agent files use that name as their `provider`. You can add several of the same kind, such as two Claude accounts or two OpenRouter keys:

| Kind | What you do |
| --- | --- |
| Anthropic | **Sign In with Claude** signs in with your Claude plan (Claude Code's `setup-token` flow, through the Claude Agent SDK bundled with SF Agents). |
| OpenAI | **Sign In with ChatGPT** signs in with your ChatGPT plan through OpenAI's Codex (bundled with SF Agents as `@openai/codex`); requests use the plan, not API billing. |
| OpenRouter | Paste an API key. |
| Custom endpoint | An OpenAI-compatible base URL (`http://127.0.0.1:8080/v1` for llama.cpp, vLLM, LM Studio, Ollama…) and, if it needs one, a key. |

Both sign-ins happen on the computer SF Agents runs on: the sign-in page opens in a new tab of its browser, you sign in and close the tab, and the sheet shows the provider was added and closes. (The page returns to a listener on that computer, so it can't be finished from a phone.)

ChatGPT requests run through `codex app-server` with Codex's own tools switched off (shell, web search, images, sub-agents, plans, questions to the user); the model gets only SF Agents' tools, which run in SF Agents' sandbox. Codex always offers its file-patching tool: it runs in Codex's read-only sandbox and every patch is declined, so nothing it writes lands. Codex keeps the ChatGPT sign-in in the OS keyring itself, under each provider's own folder (`codex/<id>` in your user folder); if it can only write a file, the sign-in is refused and the file deleted. Providers added before this change were signed in another way: remove them and add them again.

Keys and sign-in tokens go only to the system keyring, never to a file, a model, or an agent's tools or shell. The list of providers (names, kinds, addresses) is `providers.json` in your user folder (`%APPDATA%\SF Agents`, `~/Library/Application Support/SF Agents`, or `~/.config/sfagents`; `SFAGENTS_HOME` overrides it).

An agent may list several providers; when the current one reports that its account is out of quota, rate-limited, out of credit or signed out, the next takes over for the same request and stays current until it, too, runs out:

```json
{ "provider": ["Claude 1", "Claude 2", { "provider": "OpenRouter 1", "model": "anthropic/claude-sonnet-5.5" }], "model": "claude-sonnet-5-5" }
```

The agent sheet's **Account** pop-up switches by hand, among the agent's providers and other accounts of the same kinds.

The older environment-variable providers still work: `"provider": "openrouter"` with `OPENROUTER_API_KEY` (in your shell or an untracked `.env` next to the `agents` folder), and `"openai-compatible"` with `providerOptions`.

**Settings** that aren't about agents or MCP servers are in the same sheet and in `sfagents settings`: the web server's port and listen address, and whether the terminal prints reasoning and context sizes. They are kept in `settings.json` in the same user folder; the port and address apply the next time SF Agents starts, and command-line flags override them for one run.

## Commands

| Command | What it does |
| --- | --- |
| `sfagents start` | Opens (or creates) this project's persistent conversation and talks to the selected agent (`--agent <name>`, else `main`). Streams answers, shows tool activity and messages between agents, asks before risky calls. Ctrl+C cancels the running turn; `/exit` or Ctrl+D quits; `/clear` resets the working context (history is kept); `/sections` shows the topic tree; `/tree` shows the agents; `/agent <name>` hands the conversation to another agent. `--ephemeral` keeps the session in memory only. |
| `sfagents run "<task>"` | One request, ephemeral unless `--persist` (or `--conversation <file>`) records it in the conversation. The answer goes to stdout and activity to stderr. `-` reads the task from stdin. `--json` prints the structured result. Exit code: 0 done, 1 failed, 2 configuration error, 130 cancelled. |
| `sfagents web` | Serves the web interface at http://127.0.0.1:8093 (`--port`, `--host`). Prints the sign-in token the first time; `--new-token` replaces it. The same persistent conversation as `start`, with attachments, approvals in the page and the artifacts sheet. Ctrl+C stops it. See [Web interface](#web-interface). |
| `sfagents conversation …` | Inspects the stored conversation without opening it for writing: `info`, `sections`, `show <section\|unassigned\|message id>`, `search <words>`, `artifacts`. `unlock` removes a stale lock after confirmation. |
| `sfagents agents validate` | Reads the `agents` folder and prints each agent with its tools, grants, auto-approvals and roots, then the files it skipped and why. |
| `sfagents providers` | Lists the providers; `providers add <openrouter\|openai\|anthropic\|custom> [--name N] [--url URL]` adds one (asks for the key without echoing it, or prints the sign-in address), `rename <name> <new>`, `remove <name>`. |
| `sfagents settings` | Lists the app settings; `settings set <key> <value>` and `settings reset <key>`. |
| `sfagents mcp list` | Connects to each server in `mcp.json` and shows its status, tools and which agents may use it. |

Common options: `--config <dir|file>` (the project directory, its `agents` folder or one agent file; defaults to the current directory), `--agent <name>` / `-a` (the agent that replies), `--mcp <file>`, `--yes` (approve every call that would ask), `--show-reasoning`, `--show-context` (one line per turn: estimated context size, recent exchanges sent, older ones left out), `--conversation <file>`, `--page N` (for `conversation` listings).

## Files

```text
examples/                     tracked starting configurations to copy into a new checkout
agents/                       local, untracked; one JSON file per agent (main.json replies by default)
  main.json
  worker.json
mcp.json                      local, untracked named MCP servers (optional)
.env                          secrets (optional, untracked)
.sfagents/                    local conversation state (created by start; never committed)
  conversation.md             the persistent conversation: messages, sections, artifact references
  threads/<a>--<b>.md         the persistent thread between two agents (one per pair, or --2… for parallel ones)
  artifacts/<id>/r<rev>/      every revision of each artifact the agent created
  uploads/                    files attached in the web interface (and partial uploads)
```

The configurations in `examples/` provide `main` with the shell, which may message a `worker` whose workspace is read-only (two at once), and a demo MCP server. After copying them as described above, run `npx sfagents agents validate` to see them.

## Agent definition

Every `.json` file in the `agents` folder is an agent, named by its file name (`agents/Research Helper.json` is "Research Helper"). Only files that pass validation are loaded; the others are skipped with the reason (`agents validate` lists them), so one broken file never stops the rest.

```json
{
  "description": "Shown to agents that may message this one.",
  "provider": "openrouter",
  "model": "anthropic/claude-haiku-5.5",
  "systemPrompt": "You are the main agent.",
  "reasoning": "low",
  "temperature": 0.2,
  "maxOutputTokens": 4000,
  "workspace": { "roots": ["."] },
  "tools": {
    "allow": ["shell", "2-worker.json"],
    "mcpServers": ["local-tools", { "server": "github", "tools": ["search_issues"] }],
    "autoApprove": ["mcp__local-tools__*"]
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
| `name` | Optional display name. The file name is the agent's identity (an older `id` field that differs from it is shown as the name). |
| `provider` | The name of a provider you added ("Claude 1"), or a list of them in failover order (entries may be `{ "provider": "…", "model": "…" }` with their own model). Also `openrouter` (key from `OPENROUTER_API_KEY`) or `openai-compatible` with `"providerOptions": { "baseUrl": "...", "apiKeyEnv": "MY_KEY_VAR" }`. Optional: without it the agent replies with the provider picked for it in the web interface, else the first one added. |
| `model` | Any model ID the provider accepts. Optional only when `provider` is left out: then the provider's default is used (Claude Sonnet 5.5 for Claude and OpenRouter, the plan's default for ChatGPT; a custom endpoint needs `model`). |
| `reasoning` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Sent as OpenRouter's `reasoning.effort` (or `reasoning_effort` for other endpoints). Reasoning blocks are passed back across tool calls. |
| `workspace.roots` | Directories the agent may read and write, relative to the project directory. Default `["."]`. Shell commands are sandboxed to them. |
| `workspace.access` | Exceptions to the roots, like folder sharing: `[{ "path": "~/.cargo", "mode": "read" }, { "path": "secrets", "mode": "none" }]`. Modes `read`, `write`, `none`; the longest matching path wins. Paths are relative to the project directory, `~` is your home folder. Applies to shell commands and to artifact files alike. SF Agents' own files stay protected whatever an entry says. |
| `workspace.network` | `true` lets shell commands use the network (`npm install`, `git push`). Default `false`: commands are offline. |
| `tools.allow` | `"web"` adds the `sf-web` command to the shell (see Web access). The built-in tool `shell`, which reads, searches and edits files too (in the sandbox). Older files that list `read_file`, `write_file`, `edit`, `glob`, `grep` or `list_directory` still load: those entries become `shell`, with the workspace read-only when none of them could write. And **grants**: `"N-name.json"` lets this agent message the agent in `agents/name.json`, with up to N threads to it running at once (1–999). |
| `tools.mcpServers` | Server names from `mcp.json`, optionally limited to listed tools. |
| `tools.autoApprove` | Tools that skip the confirmation prompt. Built-in IDs, `mcp__<server>__<tool>` or `mcp__<server>__*`. |
| `tools.ask` | `true` asks before each shell command. Default `false`: the sandbox is the boundary. |
| `conversation.access` | Access to the persistent conversation's sections and history: `organize` (search, fetch, create and edit sections), `read` (search and fetch only) or `none`. Default: `organize` when the agent replies in the conversation, `none` when it replies in a thread. |
| `artifacts.access` | Artifacts: `create` (create, update, list and read), `read` (list and read) or `none`. Same defaults as `conversation.access`. |
| `context` | Working-context budget per request (estimated tokens) and how many recent exchanges to keep verbatim. Defaults are shown above. |
| `limits` | Turn budget, timeouts and `webRequests` (web requests per run, default 25). Defaults are shown above. |

Unknown fields are errors, so a typo cannot silently change permissions: the file is skipped, and the message names the file and field. Each agent's permissions are its own. An agent it may message can have wider permissions, or entirely different tools, roots and MCP servers; grants may form any graph, including two agents that may message each other.

## Agents talking to each other

The conversation is one thread for the user; which agent replies to it is a separate choice (`--agent`, `/agent` in `start`, or the agent menu on the web). An agent with grants gets the `message_agent` tool: `agent` (one it was granted), `message`, and optionally `thread` (which of its N threads to that agent). Its system prompt asks it to use agents freely and to write to them in terse, structured messages meant for an agent, not a person.

Each pair of agents shares **one persistent thread**, stored in `.sfagents/threads/<a>--<b>.md`. It is the same thread whoever writes first and whichever agent the user selected: when `main` writes to `worker` today and the user later selects `worker`, which writes to `main`, both see everything said before. The agent that replies does so in that thread, with its own system prompt, model, tools and roots; it sees the thread, never the user's conversation. The writer gets a structured result:

```json
{ "agent": "worker", "thread": 1, "status": "replied", "reply": "…", "turns": 3,
  "toolCalls": { "shell": { "ok": 2, "failed": 0 } }, "durationMs": 5210 }
```

`status` is `replied`, `error`, `max_turns`, `timeout` or `cancelled`. Several `message_agent` calls in one turn run **in parallel**, to different agents or to the same agent in separate threads (`threads/<a>--<b>--2.md` and so on, up to the grant's N). An agent replying in a thread can itself message other agents, also in parallel. A reply may not wait on the agent that is waiting for it (that would deadlock); it gets an error saying so instead. Cancelling the reply in the conversation cancels everything under it.

Threads are listed as artifacts of the conversation (`type: "agent_transcript"`). The web interface shows them as conversations.

## Persistent conversation

`sfagents start` continues one ongoing conversation per project, stored in `.sfagents/conversation.md` in the project directory. Close the CLI, come back tomorrow, and the agent still has the thread. The file is plain Markdown: opened in an editor or on GitHub it reads as a transcript, with metadata hidden in HTML comments. [docs/CONVERSATION-FORMAT.md](docs/CONVERSATION-FORMAT.md) specifies it.

- **Sections.** The agent replying in the conversation organizes the conversation into topics and subtopics with its section tools. Every turn it must settle the section: `keep_section` (same topic), `add_section` (a new one) or `edit_section` (back to an earlier one, or a rename or move). A turn that ends without one is sent back to the agent, at most twice, to choose; the reply it already gave stands, and that reminder round is not stored. New messages are filed under the current section. Renaming or moving a section never changes the stored messages.
- **Working context.** Each request carries the system prompt, a bounded index of section titles, and the most recent complete exchanges that fit the budget. Older material stays stored; the agent fetches it with `search_conversation` or `fetch_section` when it becomes relevant. `--show-context` prints what each turn sent.
- **Threads between agents** are stored in `threads/<a>--<b>.md` and linked from the conversation as `agent_transcript` artifacts. An agent replying in a thread cannot see the main conversation unless its definition grants `conversation.access`.
- **One writer.** A second `start` on the same conversation gets an error naming the process that holds it. A lock left by a crashed process is replaced automatically when that process is provably gone; `sfagents conversation unlock` handles anything else.
- **Durability and crashes.** Every message, tool start and tool result is flushed to disk before the next step. After a crash, the next start reports interrupted runs and marks each unfinished tool call as either "never started" or "outcome unknown". Nothing is retried automatically, and the model is told which is which. A damaged ending is moved to `.sfagents/recovered/` and recorded, never silently dropped.
- **What is not restored.** "Always allow" approvals and `--yes` apply to the running process only. On resume, tools and permissions come from the current agent files.
- **Privacy.** `.sfagents/` contains a `.gitignore` that excludes everything in it, and agent shell commands cannot read or write it. Conversations can still contain anything you or your tools put in them, so treat the folder as private.

## Artifacts

An artifact is something the agent makes for you to keep rather than say in a message: a document, a web page, an SVG drawing, code, data, a PDF, an image, or a running web app. **An artifact is the file itself**, not a copy: the agent writes a file in its workspace (or lets `create_artifact` write it, which asks like `write_file`) and `create_artifact` shows it. From then on the artifact is whatever the file is: edit the file (the agent with its tools, or you in the file manager) and the chat's preview and the tile update. `create_artifact` with an artifact's `id` changes that artifact instead: a new title, another file, or new content for its file. The agent sees an index of recent artifacts (with their files) in its system prompt and reads them as files with the shell; `artifacts.access: "read"` gives an agent that index and no artifact tools.

Where a file is decides how it is shown:

- `.sfagents/threads/` holds the threads between agents: they open as conversations, also from the file manager.
- `genui/` in the project is reserved for GenUI components (structured, interactive pieces shown inline in the chat); their format is still to be defined, so for now they show like other files.
- Everything else shows by its type, with a preview, and opens in the file manager's Quick Look.

**Application artifacts**: when the agent starts a web app (a dev server on a port of this computer), `create_app_artifact` with the port makes it an artifact. It opens inside SF Agents, served through SF Agents' own address under `/apps/<id>/`, so you can try a prototype from your phone over whatever already reaches SF Agents (your LAN, Tailscale Serve) without exposing another port. The app's absolute paths (`/src/…`, `/@vite/client`, its own `/api/…`), redirects and live-reload sockets are routed back to it. It works while the app runs.

Artifacts are recorded in the conversation (`artifact`, `artifact_update` and `artifact_pin` records, with the file's path or the app's address), so the list survives restarts. Artifacts from before this version, whose contents were copied into `.sfagents/artifacts/`, still open. You pin artifacts in the web interface; `sfagents conversation artifacts` lists them.

## Web interface

```sh
npx sfagents web            # http://127.0.0.1:8093
npx sfagents web --port 9000
```

**Signing in.** The first time `sfagents web` starts, it prints an access token (`sfa_…`) once. Keep it somewhere safe, such as a password manager: SF Agents stores only a scrypt fingerprint of it in the OS keyring (Windows Credential Manager, macOS Keychain or the Secret Service keyring), so neither the token nor anything that would let an agent sign in is in a file, and without a keyring the web interface does not start. Every device opens on a sign-in page; paste the token there. Afterwards the page offers to add a **passkey** (Face ID, Touch ID, Windows Hello or a password manager) so that device can sign in without the token. Passkeys need a secure origin: `localhost`, or HTTPS through a reverse proxy such as Tailscale Serve with `--public-origin`. A device stays signed in for 90 days after it was last used; Settings → Signed-In Devices lists the devices and passkeys, signs devices out and removes passkeys. `sfagents web --new-token` replaces the token, signs every device out and removes the passkeys. Wrong tokens are limited to ten per ten minutes.

The page is one conversation in the style of iMessage, with a bottom bar in the style of Apple Maps:

- **Messages** use iMessage's dark-mode bubble shapes and colours. Assistant replies render Markdown. Tool use appears as small grey lines ("Read src/app.ts"), and a typing bubble shows while the agent works.
- **Topics** appear as small grey dots along the right edge, one per section the agent has organized the conversation into, oldest at the top and newest at the bottom (the dot for the part you are reading is brighter). Press and hold on the dots and they expand into the topic titles; move up and down to choose (nothing scrolls yet), hold near the top or bottom to scroll through a long list of titles, and release to jump to that topic. With a keyboard: focus the dots, press Enter or an arrow key, move with the arrows and press Enter.
- **The bar** holds the message field. **+** opens the file and photo picker (you can also drop or paste files), the microphone dictates (see **Dictation** below), and the circle on the right sends (or stops a running turn). The field grows with the text and then scrolls, as in iMessage. Return sends on a desktop (Shift+Return adds a line); this is a setting.
- **Swipe anywhere on the bar** (or tap the handle, or use the arrow keys on it) and it becomes a glass sheet; swipe further and it becomes an opaque sheet. Swipe down to close it; in the full sheet, pulling down at the top of the list closes it, as in Maps. Below the field: the **resource monitor**, aligned with the field: CPU (use, temperature, cores), GPU (use, temperature, VRAM used/total), memory, disk read and write activity, network down and up, process count with PSU-reported system wattage when available, the computer's and SF Agents' uptimes, and a bar per drive with used/total and how full it is (three share the width; swipe sideways for more). It reads the machine only while the sheet is open, every two seconds. The sensors are built in and start with SF Agents; there is nothing to turn on or point at. Windows uses a bundled [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) library adapter, started and stopped by SF Agents; no separate app or web server is needed. Linux uses bundled [LibreHardwareMonitor-Linux](https://github.com/insight-it-gmbh/LibreHardwareMonitor-Linux) collectors and a private Python runtime, supplemented by native OS readers; macOS keeps its native readers. See [Linux sensors](docs/LINUX-SENSORS.md) for coverage, optional tools and packaging. **Administrator rights** are asked for once, when `sfagents web` starts, and cover everything SF Agents does with them, so no feature asks when it is first used: on Windows one UAC prompt, which installs the signed PawnIO driver CPU temperatures are read through and what Remote Desktop needs (the first time; see below) and starts the read-only sensor worker elevated; on Linux one `sudo` password prompt in the terminal, when `smartctl` or `ipmitool` is installed (so that drive temperatures and the BMC can be read) or Remote Desktop's input rule is not in place yet. SF Agents itself, its web server and the agents' tools stay at your own level. Declining leaves the monitor on what an ordinary user can read. See [Windows sensors](docs/WINDOWS-SENSORS.md) for building, packaging and permissions. Drive sizes always come from the file system, per volume. Tap any reading to open its **window** (it grows out of the reading, like a held notification): live graphs and details in the spirit of Windows Task Manager — CPU (per-core graphs, speed, power, temperatures), GPU (sensors, VRAM), memory (composition, committed, swap), disks (per-disk activity, volumes), network (per adapter, addresses), system (sensors), SF Agents itself, and **Processes**: search, sort, a per-process view (PID, parent, user, CPU and memory over time, command line, children), End Task, Force Quit, End Process Tree and priority, plus Users, Services (start, stop, restart) and Startup items. Windows stack like a navigation view; swipe down, tap outside or press Escape to close.

The monitor's expand button opens **Files**, an opaque sheet that slides up from the bottom and stops just under the status bar, as the Claude app's sheets do (no medium height; drag its top or pull down at the top of the list to close it): a glass close button at the top left, the readings as glass chips beside it (each still opens its window), a ⋯ button at the top right, and the drives as Liquid Glass bars along the bottom, each with its name, used/total and percentage on one line (tap one to open it; the monitor's drive bars open it too). Browse lists your folders, the SF Agents project, the Trash, drives and favorites; folders show as a list or icons, sorted by name, date, size or kind, with hidden files on request, breadcrumbs and search (this folder at once, the folders inside after a pause). Hold an item (or right-click it) for a menu like Apple's: Share, Download and Info, Quick Look, Rename, Duplicate, Move, Copy to…, Compress or Uncompress (ZIP), Copy, Cut, Copy Path, Ask SF Agents (attaches the file to your message), favorites, Delete (to the system Trash, with Undo) and Put Back. ⋯ has Upload (the browser's file and media picker, into the open folder; dropping files works too), New Folder, Select (with a toolbar for many items), New Text File, Paste, view and sort options, Get Info, Copy Path, Download as ZIP and Empty Trash. Quick Look previews images, video, audio, PDFs, Markdown, HTML (without scripts), text and code, with an editor for text files; swipe or use the arrow keys between files. Name clashes ask whether to keep both, replace or skip; long operations show progress and can be cancelled. Keyboard: arrows, Space (Quick Look), F2, ⌘/Ctrl+A, C, X, V, Delete, ⌘/Ctrl+I and ⌘/Ctrl+↑. Next to it, four round buttons spread evenly down the monitor's height under the send button: **Settings** (providers, this device's glass quality and Return key, and the settings kept on the computer; see [Providers and settings](#providers-and-settings)), **Terminal**, **Remote Desktop** and **Search**.

**Terminal** is a full terminal emulator (xterm.js) on real shells (your login shell on macOS and Linux; PowerShell 7, else Windows PowerShell, on Windows), started in the project folder. Tabs keep running when the sheet closes or the page reloads, and any device can attach to them; the last 512 KB of output is replayed on attach. On touch screens a key bar adds Esc, Tab, Ctrl, the arrows and a few symbols. Provider keys are removed from the shells' environment.

**Remote Desktop** shows this computer's screen in a sheet. It is built into SF Agents from [MoonlightWeb](https://github.com/linckosz/moonlight-web) (GPL-3.0-or-later): its engine captures and encodes the screen on the GPU (NVENC, AMF, Quick Sync, VA-API) and sends it to the browser over WebRTC, and its stream view plays it, with sound, keyboard, mouse, touch, the clipboard and gamepads. There is nothing to set up and no second program: the engine is `sfagents-screen`, a helper SF Agents downloads from this repository's releases at its first start (checked against the SHA-256 pinned in `web/src/screen.ts`; built by `.github/workflows/screen.yml` from `web/native/screen`), and the stream page is SF Agents' own (`web/public/screen`, built from MoonlightWeb's by `scripts/vendor-screen-page.mjs`). SF Agents' server starts one helper per stream and carries its signaling through its own address (`/api/screen/ws`), behind SF Agents' sign-in. On Windows the stream shows the computer's main screen. The one administrator approval SF Agents asks for when it starts (see the resource monitor above) also installs what that needs: the helper under Program Files, a firewall rule for the stream, and ViGEmBus for gamepads. A virtual display made for the device, at its size, is off for now: with `SFAGENTS_SCREEN_VDISPLAY=1` the approval also installs its driver and a scheduled task that turns it on and off without asking again. It is only made the main screen on a computer with no other screen on. On Linux the same sudo prompt adds a udev rule so the helper can type and click (`/dev/uinput`); the screen is captured through the desktop portal. The ⋯ button has this device's **Resolution** (Automatic, This Screen, 1080p, 720p) and, on Windows, its **Display Scaling**: SF Agents applies each device's scaling to the virtual display when that device starts streaming and keeps whatever it is when the device stops, so a change made in Windows' own Settings stays with that device. Video is decoded by the browser, which allows it only on a secure origin (localhost or HTTPS), and travels peer to peer over UDP to the computer's own addresses (a Tailscale address works), with a WebSocket fallback through SF Agents. One device streams at a time. macOS builds are not published yet.

**Dictation** runs on the computer SF Agents runs on, with [Qwen3-ASR 1.7B](https://huggingface.co/audio-cpp/audio.cpp-gguf/tree/main/Qwen3-ASR-1.7B-GGUF) (audio.cpp's official Q8_0 GGUF, 30 languages) in [audio.cpp](https://github.com/0xShug0/audio.cpp)'s `audiocpp_server`. Tap the mic, speak, tap again: the text goes in at the cursor. The runtime and both models come with the install: `npm install` and `npm run build` download audio.cpp v0.9.3's build for this computer (pinned in `web/src/dictation.ts`), Qwen3-ASR (about 2.5 GB) and VibeVoice (about 3.2 GB) into `dictation` in the SF Agents folder, once (about 6.7 GB with the CUDA build); everything is checked against its SHA-256, a dropped connection is retried, and an interrupted download resumes. `SFAGENTS_SKIP_SPEECH=1` skips it, and `npm run build:speech` runs it alone. Whatever the install could not get downloads when `sfagents web` starts (a tap before it is there waits for it). The build is chosen GPU first: Metal on macOS, CUDA with an NVIDIA driver on Windows, else Vulkan when a Vulkan loader is installed (NVIDIA on Linux too), else the CPU build. A GPU build that cannot start or load the model is skipped for the next one. The server listens only on 127.0.0.1, starts with SF Agents and keeps Qwen3-ASR loaded. Once audio.cpp runs, the files the earlier llama.cpp version downloaded are removed. The browser records with MediaRecorder and sends 16 kHz WAV, so it works in any current browser, but browsers allow the microphone only on a secure origin (`localhost`, or HTTPS such as Tailscale Serve).

**Reading aloud** uses [VibeVoice 1.5B](https://huggingface.co/audio-cpp/audio.cpp-gguf/tree/main/VibeVoice-1.5B-GGUF) (Q8_0) in the same server. `POST /api/speak {"text": …}` returns the whole reply as one WAV (`web/public/speech.js` plays it). **Settings → STT & TTS** has the models' state, a **Glossary** (names and terms, separated by commas, given to Qwen3-ASR as context), a **Reference Voice** (any audio file the browser can read; its first minute is kept as a 24 kHz WAV, and VibeVoice copies the voice), the **Guidance Scale** (0.5 to 3, default 1.3), a sample to listen to, and **Automatic Model Swap** for graphics cards without room for both models: Qwen3-ASR is unloaded while VibeVoice speaks, VibeVoice is unloaded when it is done, and Qwen3-ASR is loaded again at once; dictation that comes in meanwhile waits. Without the swap both stay loaded.

**Search** looks through every message of the conversation (also ones not loaded yet) and the artifacts' titles and text; a message result jumps to it in the chat, an artifact result opens it.

Quick Look's editor: the glass pen button starts editing; the close button at the top left leaves the editor (the preview stays), and the check at the top right saves and returns to the updated preview. Agent files and `mcp.json` are reloaded as soon as they change, here or in any editor: new agents appear in the menu, changed ones are used from the next turn, and a file with an error is skipped (with a note) while the others keep working.

The round button at the right of the field is the **agent button** when there is nothing to send: it shows the app icon's character, and its glass refracts a moving gradient made from the model's name (the same model always gets the same gradient; another model gets a different one). With text it becomes the blue send button, and while a reply runs, stop. Tap it with nothing to send, or hold it (right-click with a mouse) at any time, for the agent sheet: at medium height the **agent** (a pop-up button: tap it for a menu of the project's agents, with each one's model), its **account** (the provider it replies with; see [Providers and settings](#providers-and-settings)), a gear at the top that opens the agent's file in the editor, a **reasoning effort** slider (Low, Medium, High, Extra High, Max; kept per agent in `.sfagents/web-agent.json` and sent with every request instead of the agent's `reasoning` setting) a **usage** bar for ChatGPT and Claude plans (one bar split in two: the share of the 5-hour limit used on the left, of the weekly limit on the right, with when each resets underneath; ChatGPT's comes from Codex, Claude's is what Claude reported during the last reply) and a **context** bar (how much of the working-context budget the next request uses). Drag it up for the breakdown: a bar and list of the system prompt, built-in, MCP, agent and conversation tools, the section index and notes, the messages, the share kept free for each turn and what is left; each tool family's tools and their sizes; the budget, the model's own context window when the provider lists it, the exchanges and sections kept, and the provider's figures for the last request. **Start a Fresh Context** makes later replies start without the earlier messages (they stay stored and searchable). Changes in the agent sheet and in Settings are saved by the check button at the top right; the close button at the top left, a swipe down or Escape leave without saving. All sheets and windows put their close button at the top left.

In the chat, a message one agent sends another shows as a line with a chevron: tap it to open their **thread** in a sheet, as a conversation, following it live. An artifact the agent creates or updates shows as a **card with a preview** right after the call that made it; tapping it (or its tile) opens it in the file manager's Quick Look. Then **Pinned** artifacts, a divider, and all artifacts, newest first, as glass tiles. Tap a tile to open it; the pin button pins or unpins it.
- **Approvals** appear as a card in the conversation (Allow Once, Always Allow, Don't Allow). `--yes` skips them.
- **Attachments** upload with an up2k-style protocol (after [copyparty](https://github.com/9001/copyparty)'s up2k): the browser hashes each chunk, the server asks only for chunks it does not have, chunks upload in parallel and are verified on arrival, an interrupted upload resumes (choose the same file again), and a file the server already has is not uploaded at all. Images are shown to the model; text files are included in the message; other files are named.

It is also a simple installable web app (manifest, icons, standalone display): use "Install" in Chrome or Edge, or Share → Add to Home Screen in Safari. Browsers only offer installation on a secure origin, which includes `localhost`/127.0.0.1 but not a plain-http LAN address.

The glass is [sfgl](https://github.com/JoeDoe56/sfgl) (vendored in `web/public/vendor/sfgl`; refresh it with `npm run vendor:sfgl -- <path to sfgl>`), and the font is Host Grotesk. Add `?quality=superfluid|glass|lite|frost|static` to the URL to force a glass quality tier.

Security: the server listens on 127.0.0.1 only, accepts only requests addressed to this host and port, and refuses cross-site writes (and cross-site terminal connections). Artifacts and uploads are served in a sandbox, so a page the agent wrote cannot call the API. Application artifacts are the exception: an app runs as it would on its own port, on SF Agents' origin, so treat it like any program you run. `--host 0.0.0.0` exposes the sign-in page to your network; once signed in, a device has the agent and its tools (with your permissions). Plain HTTP on a LAN sends the session cookie unencrypted, so prefer HTTPS through a reverse proxy.

Behind a reverse proxy such as Tailscale Serve, keep the loopback bind and set
`--public-origin https://your-service.example.ts.net`. This accepts that exact
external Host and browser origin while continuing to reject unrelated hosts and
cross-origin writes. The sign-in gate still applies, and the session cookie is marked Secure.

## Permissions (enforced in code, not in prompts)

- **Tool allowlists** are checked when each call is executed. A model asking for a tool it was not given gets an error back; nothing runs.
- **Each agent has exactly its own permissions.** Messaging another agent never passes on the writer's tools or roots, and the other agent's are not limited by the writer's: grant wider or different ones when you want them. Grants are explicit (`N-name.json`). The loaded definitions are frozen.
- **Shell runs in an OS sandbox**: bubblewrap on Linux, Seatbelt (`sandbox-exec`) on macOS, and a dedicated standard account with a restricted token and Job Object on Windows. A command can read and write the agent's workspace roots and read system folders; personal files are hidden and its home/temp are disposable. There is no network unless the agent sets `"workspace": { "network": true }`. Inside the roots, `.env` and `.sfagents/` are hidden, and the `agents` folder, `mcp.json`, `.git/hooks`, `.git/config` and `.git/modules` are read-only (missing guarded files/folders are created first so they can be protected). Commands run without asking; set `"tools": { "ask": true }` to approve each one. **Without a sandbox, every command is refused** (install `bubblewrap` on Linux). Windows needs explicit setup: `npm run sandbox:setup`; undo with `npm run sandbox:uninstall`. See [Windows sandbox setup, design and tests](docs/WINDOWS-SANDBOX.md).
- **Artifacts** are written by the host, not the shell, under the same rules: canonical real paths (following `..` and symlinks), the roots and `workspace.access`, and SF Agents' own files protected. They do not ask.
- **MCP calls ask before running.** Exceptions: tools listed in `autoApprove`, MCP servers marked `"trust": true`, and the `--yes` flag (which also approves shell commands of agents with `tools.ask`). In `run` mode without a terminal, calls that need approval are denied and the model is told why.
- **MCP servers are not workspace-confined.** A server can reach anything its own process can. Grant servers per agent, preferably limited to specific tools.
- **Provider keys and sign-ins** live in the system keyring; no shell command, MCP server or terminal tab gets them in its environment, and they are never sent to a model.
- **Conversation state** (`.sfagents/`, including threads and uploads) is invisible to shell commands; it changes only through the conversation service and the web server.
- **Secrets:** the configuration directory's `.env` cannot be read or written by shell commands or artifacts (including through symlinks). Provider key variables are removed from the environment of shell commands and stdio MCP servers, and are never sent to the model.

## Web access

Shell commands are offline, but an agent with `"web"` in `tools.allow` (next to `"shell"`) gets an `sf-web` command in its sandbox:

```sh
sf-web search kiln firing schedule cone 6 > results.json   # Google results, as JSON
sf-web markdown https://example.com/glazes > glazes.md      # a page as Markdown
sf-web html https://example.com/glazes                      # a page as HTML
```

`sf-web` talks to SF Agents through a socket that exists only while the command runs; SF Agents makes the request with [Bright Data](https://brightdata.com)'s hosted MCP server (`search_engine`, `scrape_as_markdown`, `scrape_as_html`). Add the Bright Data API key in **Settings → Providers → Web Access**, or with `sfagents providers web-key`. It is kept in the system keyring and never enters the sandbox. Each run may make `limits.webRequests` requests (default 25); a result is cut at 1 MB, and a request times out after 90 seconds. Bright Data includes 5,000 free requests a month, then bills per request: set a spend limit in its control panel.

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
  agents/       JSON schema, agents-folder loader, threads, message_agent
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

- The ChatGPT (Codex) and Claude sign-ins have not been run with real accounts in this repository's tests. The Codex provider is tested against the real `codex` binary with a local stand-in for OpenAI (tools offered, tool calls captured, patches declined); the sign-in and usage calls are tested with a stand-in for Codex. Claude requests go through the Claude Agent SDK and carry the whole conversation each time, as LLM-Proxy's do, and so do ChatGPT requests (as Codex history).
- Claude reports plan usage only in rate-limit events during a reply, and may send one only when usage crosses a threshold, so its usage bar can stay empty until then.
- App artifacts share SF Agents' origin. Paths are routed to the app by the page that asked for them; an app that loads a path SF Agents also serves (for example `/app.js`) from a page outside `/apps/` may get SF Agents' file.

- Search is lexical (all query words must appear); there is no semantic or embedding search yet, and no section summaries.
- Section deletion and merging are not supported yet.
- Token counts for the context budget are estimates (characters ÷ 4).
- On Linux and macOS, if SF Agents itself is force-killed, a shell command it started may keep running; the next start reports that call's outcome as unknown. The Windows broker watches SF Agents and closes its Job Object when that parent exits.
- Windows sandbox commands are serialized while temporary file permissions are applied. A command waiting more than 25 seconds reports that the sandbox is busy; narrow workspace roots also reduce permission propagation time.
- Windows sandbox runtime limits: PowerShell startup and Node subprocesses with piped output currently fail. Direct Git commands through `cmd` and Node file operations work. See [runtime compatibility](docs/WINDOWS-SANDBOX.md#runtime-compatibility).
- Model output is text only; MCP image and audio results are summarized, not shown to the model. Attached images are shown to the model (if it supports images); other binary attachments are only named.
- The web interface has one conversation and one user: every signed-in device has the same access. The file manager works with the files of the account SF Agents runs as; any signed-in device can read, change and delete those files.
- No MCP OAuth flow; use headers with environment variables.
- Windows: the first milestone was verified on Windows; the conversation features were developed and tested on Linux, and run their deterministic tests on Windows through `scripts/windows-smoke.ps1`.

## License

SF Agents is licensed under the GNU General Public License, version 3 ([LICENSE](LICENSE)). Files derived from Qwen Code and Gemini CLI keep their Apache License 2.0 headers ([licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)), which is compatible with GPL-3.0; [NOTICE](NOTICE) and [PROVENANCE.md](PROVENANCE.md) list them and the other third-party components.
