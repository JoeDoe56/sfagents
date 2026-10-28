# SF Agents conversation format (version 1)

This document specifies the single Markdown source behind SF Agents' persistent conversation. It holds the chronological transcript, the semantic section hierarchy and artifact references. Every client (CLI today, a graphical client later) reads it through Core's `ConversationService`. Only that service writes it.

Design goals, in priority order:

1. **Authoritative and recoverable.** Everything needed to resume, replay to a provider, navigate sections and find artifacts is in the Markdown. Caches are optional and rebuildable.
2. **Append-only.** Records are only ever appended. Reorganizing sections appends operations; earlier messages never move or change.
3. **Readable.** Opened in an editor or on GitHub, the file reads as a conversation. Metadata sits in HTML comments that renderers hide.
4. **Robust framing.** Message bodies may contain any Markdown, code fences, HTML comments, Unicode, or text that looks like SF Agents markup.

## Files

```text
<config dir>/.sfagents/
  conversation.md          main conversation (this format, kind "main")
  threads/<a>--<b>.md      the persistent thread between two agents (this format, kind "thread")
  recovered/               damaged tails moved aside during recovery
  artifacts/<id>/r<rev>/   content of each artifact revision
  uploads/<id>/<name>      attached files (uploads/.up2k/ holds partial uploads)
  conversation.lock        present while a writer has the conversation open
  .gitignore               "*" so the folder is never committed by accident
```

`<config dir>` is the project directory (the one holding the `agents` folder). A different conversation file can be chosen with `--conversation <file>`; its transcripts and lock then live next to it.

## Encoding

- UTF-8 without a byte-order mark. SF Agents writes `\n` line endings in frame lines. Readers accept `\r\n` frame lines.
- Message bodies are stored byte-exact, including any `\r\n` they contain.
- The file is a sequence of **records**, separated by any number of blank lines. Any other text between records is a format error, reported with its line number.

## Records

A record starts with a **header line**:

```text
<!-- sfa:<kind> <json> --><optional decoration>
```

- `<kind>` is a lowercase name from the table below.
- `<json>` is a single-line JSON object. Writers escape every `>` in it as `>`, so the header can never contain `-->` early. Readers parse the text between the kind and the first ` -->`.
- **Decoration** is optional presentation HTML after `-->` on the same line, for example `<b>user</b>`. It makes the transcript readable when rendered. Readers ignore it; writers regenerate it.

Most records are just the header line. Records that carry text (`message`) have a **body** framed by a boundary token:

```text
<!-- sfa:message {"id":"m12",...,"b":"Q7f2"} --><b>user</b>
How should we handle retries in the uploader?
<!-- sfa:end Q7f2 -->
```

- The body is every byte after the header line's newline, up to (not including) the newline before the closing line `<!-- sfa:end <b> -->`.
- The writer picks a random boundary `b` (letters and digits) such that `<!-- sfa:end <b> -->` does not occur in the body. A body can therefore contain anything, including other SF Agents headers.
- If the record has `"fence"` (used for tool output), the body is wrapped in a code fence for readability: the line after the header is the opening fence (`fence` plus an optional info string), and the line before the closing marker is the closing fence. The fence is a run of backticks longer than any backtick run in the content. Readers strip both fence lines and the newline before the closing fence.

### Record kinds

All records have `seq` (integer, strictly increasing by 1 from 1 within a file) and `time` (ISO-8601 UTC). Order is defined by `seq`, never by `time`.

| Kind | Body | Fields | Meaning |
| --- | --- | --- | --- |
| `conversation` | no | `v` (1), `id`, `kind` (`main` or `transcript`); transcripts add `run`, `parentRun`, `agent` | First record of every file. |
| `message` | yes | `id` (`m<seq>`), `run`, `role` (`user`, `assistant`, `tool`), `agent` (agent path, e.g. `main/worker`), optional `section` | One message. See below. |
| `run_start` | no | `run`, `agent`, optional `parentRun`, `callId`, `provider`, `model`, `reasoning`, `config` (definition file, relative), `configHash` | An agent run began, and the configuration in effect. |
| `tool_start` | no | `run`, `callId`, `tool` | Execution of a requested tool call is about to begin. |
| `run_end` | no | `run`, `status` (`GOAL`, `ERROR`, `MAX_TURNS`, `TIMEOUT`, `CANCELLED`), optional `error`, `turns`, `usage` | A run finished. |
| `section` | no | `op` (`add` or `edit`), `section`, `rev`, `expected`, plus operation fields | A change to the section hierarchy. |
| `artifact` | no | `id` (`a<seq>`), `type`, `title`, optional `path`, `run`, `message`, `callId`, `mime` | Something displayable produced in the conversation (revision 1). |
| `artifact_update` | no | `artifact` (an artifact ID), `rev` (exactly one more than the current revision), optional `path`, `title`, `mime`, `run`, `callId` | A new revision of an artifact. |
| `artifact_pin` | no | `artifact`, `pinned` (boolean) | The user pinned or unpinned an artifact. |
| `context_reset` | no | none | `/clear`: the working context starts fresh after this point. History stays searchable. |
| `interrupted` | no | `run`, `notStarted` (call IDs), `unknown` (call IDs) | Written on reopen for runs that never ended. |
| `recovery` | no | `reason`, `savedTo` (relative path), `bytes` | A damaged trailing record was moved aside. |

### Messages

| Role | Body | Extra fields |
| --- | --- | --- |
| `user` | The user's text, exactly as entered. | `attachments`: `[{"id","name","mime","path","size"}]`, files the user attached; `path` is relative to the `.sfagents` directory (`uploads/<id>/<name>`) |
| `assistant` | The model's visible text (may be empty). | `toolCalls`: `[{"id","name","arguments"}]` with `arguments` as the exact JSON string sent to the provider; `reasoning` (text) or `reasoningDetails` (array), opaque provider continuation data stored unmodified; `finish` (provider finish reason) |
| `tool` | The full text returned to the model, fenced. | `callId`, `tool`, `status` (`ok`, `error`, `denied`, `cancelled`, `not_started`) |

A `tool` message always follows the `assistant` message that requested it, in the same `run`. Model replay needs only `message` records. The others give lifecycle, navigation and recovery.

Only complete assistant messages are written. Streaming text is not persisted until the provider finishes the turn. A cancelled stream leaves the user message, a `run_end` with `CANCELLED`, and no partial assistant message.

## Sections (semantic topics)

Sections form a tree that the model maintains with tools; the CLI can inspect it.

- `add`: `section` (new ID `s<n>`), `title`, optional `parent`, optional `assign` (message IDs), optional `current` (boolean).
- `edit`: `section`, optional `title`, optional `parent` (`null` moves it to the top level), optional `assign`, optional `unassign`, optional `current`.
- `rev` is the resulting **structure revision**, which increases by 1 with each section record. `expected` is the revision the caller based the change on. The service rejects a stale `expected` before writing anything, so a section record in the file is always a change that was accepted.
- A message's section is the last `assign` or `unassign` that names it. Without one, it is the message's own `section` field. Without that, it is unassigned.
- New messages are written with `section` set to the **current section**: the last section an operation marked `current: true`, or the one most recently added. This keeps a running discussion grouped without a classification call for every message.
- `tool` messages belong with the `assistant` message that requested them; only `user` and `assistant` messages are assigned.
- Invariants checked on load: unique section IDs, parents exist, no cycles, assigned messages exist and are `user` or `assistant`.
- Renaming or moving a section never changes message IDs, bodies or order. Deleting and merging sections are not part of version 1.

## Runs and threads between agents

Every agent invocation has a run ID (`r` + 10 random base-36 characters). Runs of the agent replying to the user write to the main conversation. When an agent messages another with `message_agent`:

1. The pair's thread is `threads/<a>--<b>.md` (the two agent names sorted, so it is the same file whoever writes; `--N` is appended for a second or later parallel thread). Its `conversation` header has `kind: "thread"` and `agent: "<a>,<b>"`.
2. The writer's message is appended to the thread as a `user` message whose `agent` is the writer. The replier's `run_start`, messages and `run_end` follow, with `agent` set to the replier.
3. The first time a thread is used from a conversation, the conversation gets an `artifact` record: `type: "agent_transcript"`, `path: "threads/<key>.md"`, with `run`, `callId` and `message` of the call that started it.
4. The writer receives only the structured reply as its tool message. When an agent replies in a thread, its context is the thread: the other agent's messages and replies are user turns, its own earlier messages and replies are its assistant turns.

Older conversations may hold `transcript` files under `transcripts/<run>.md` from the previous child-agent design; they still load and display.

## Artifacts

An `artifact` record references displayable content; it does not contain it. `path` is relative to the `.sfagents` directory for managed content (threads, artifacts), or to the configuration directory for project files.

File artifacts record `file`: the user's file the artifact shows, relative to the project directory with `/` separators (or absolute outside it). Nothing is copied; the artifact is the file as it is now. Application artifacts record `url`, the address of an app on this computer (`http://127.0.0.1:<port>/…`). An `artifact_update` may change `title`, `file` or `url`. Older artifacts with a `path` under `artifacts/<id>/r<rev>/` are managed copies and still read.

- A missing backing file is reported as a missing artifact. The conversation still loads.
- Artifact records grant no filesystem or execution permissions.

The runtime writes `agent_transcript` artifacts for child runs. Model-created artifacts (`create_artifact`) store their content under `artifacts/<id>/r1/<file name>` and use a display `type` derived from the file extension: `document` (Markdown), `html`, `image` (SVG and raster images), `code`, `data` or `text`. Readers accept any `type` string.

Retitling or repointing an artifact (`create_artifact` with its `id`; `update_artifact` in older conversations) writes the next revision to `artifacts/<id>/r<rev>/<file name>` and appends an `artifact_update`; earlier revision files are kept. `artifact_pin` records are written by clients when the user pins or unpins. The current view of an artifact (latest path, title, revision, pin state) is the `artifact` record with every later `artifact_update` and `artifact_pin` for it applied in order. An update that skips a revision, or an update or pin naming an unknown artifact, is a semantic error.

`artifact_update` and `artifact_pin` were added after the first release of version 1. Older SF Agents builds report them as unknown record kinds.

### Attachments

A user message's `attachments` reference files under `uploads/`. The body stays exactly what the user typed. When the message is sent to a model, images (PNG, JPEG, GIF, WebP up to 20 MB) become image parts, readable text files up to 200 KB are appended inside `<attachment name="…" type="…">` tags, and other files are named with a note. A missing file is reported to the model as no longer available; the conversation still loads.

## Locking, durability and recovery

- **Single writer.** A writer creates `conversation.lock` exclusively, containing `{"pid", "host", "started"}`. A second writer gets an error naming the holder. If the lock's process no longer exists on this host, the lock is stale and is replaced. A lock held from another host is never assumed stale; `sfagents conversation unlock` removes it after the user confirms. Readers (inspection commands) take no lock.
- **Commit boundary.** Each record is written with one append and flushed (`fsync`) before the runtime continues. The most a crash can lose is the record being written.
- **External changes.** Before each append, the writer checks that the file size is still what it last wrote. If someone else changed the file, writing stops with an error rather than interleaving.
- **Damaged tail.** If a file ends in an unfinished record (no closing marker, or an unparseable header line), the writer copies those bytes to `recovered/<file>-<time>.txt`, truncates the file at the last complete record and appends a `recovery` record. The damage is never silent, and the bytes are kept.
- **Damage elsewhere** (for example a bad manual edit) is reported with a line number, and the conversation will not open for writing until it is fixed. Manual edits made while no writer is running are fine as long as the file stays valid.
- **Interrupted runs.** On open, each run with a `run_start` but no `run_end` gets an `interrupted` record. Its tool calls are classified as `notStarted` (requested, no `tool_start`) or `unknown` (started, no result). Nothing is retried automatically. When the working context is rebuilt, each unresolved call gets a clearly labelled synthetic tool message saying whether it never ran or its outcome is unknown. These synthetic messages are never written as observed `tool` messages.
- **Authority.** `run_start` records note the model and configuration in effect, for provenance only. On resume, SF Agents always uses the current validated agent files; stored data never restores tools, permissions or "always allow" approvals.

## Versioning

The `conversation` record's `v` is the format version. A reader refuses a file whose `v` is newer than it supports, with a clear message, rather than guessing. Unknown record kinds in a supported version are errors. Unknown fields in known kinds are kept on round-trip but otherwise ignored.

## Example

See [tests/fixtures/conversation-v1.md](../tests/fixtures/conversation-v1.md). It contains a user/assistant exchange; a tool call and result; nested sections with a rename and a move; a child run with its transcript artifact; a context reset; an interrupted run; and a message body containing code fences and fake SF Agents markup.
