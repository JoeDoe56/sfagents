# Plan: persistent conversation and semantic memory

Status: implementation plan; the features below are not implemented yet.

Scope: parts 1–3 of the proposed next steps: define the conversation format,
add persistence and resume, then add semantic organization and retrieval.

Source: `SF_Agents_Feature_Specification.md`, supplied by the project owner,
especially sections 2–6, 8, and 14. This plan includes the relevant requirements
so it can be implemented without access to that attachment. Technical choices
below are proposals unless explicitly identified as product requirements.

## Outcome

SF Agents should maintain one continuous conversation that survives restarts.
The model should organize that conversation into hierarchical topics and fetch
historical details when needed, without sending the entire history on every
request. Conversation messages, topic structure, and artifact references must
share one authoritative Markdown source. Artifact contents can live in referenced
files or directories.

The CLI remains usable throughout. A later graphical client must be able to use
the same conversation service and topic data without inventing another history
format or memory system.

## Current baseline

- Core and CLI are independent packages, with typed runtime events.
- Agent definitions, permissions, file tools, shell, MCP, and nested delegation
  already work. Preserve their existing behavior and boundaries.
- `AgentSession.messages` in `core/src/runtime/runtime.ts` holds context in memory.
- Each child invocation currently creates a fresh, temporary message array.
- The runtime appends full assistant and tool messages, but its UI events expose
  only part of that information. Persisting the existing events alone would lose
  data needed to reconstruct provider requests.
- `sfagents start` creates an in-memory session; `/clear` replaces it.
- There is no durable conversation store, topic model, artifact registry, or
  input-context budget.
- Verification after the Windows grep fix: 82 deterministic tests passed,
  two Windows symlink tests skipped. Five live provider tests passed before
  that fix. Those live results do not verify the features proposed here.

## Boundaries for these three parts

Include the minimum artifact-reference and child-transcript representation now,
because both affect the conversation format. Do not implement a graphical
renderer, executable application artifacts, parallel child scheduling, live
parent-child messaging, mobile synchronization, or a background daemon here.

Do not introduce an external memory service or require a vector database.
Rebuildable indexes and caches are allowed; they are not a second source of truth.
Do not change existing agent configuration or permission semantics except for
explicitly documented additions needed by this plan.

## Part 1 — Define the conversation format

### 1.1 Specify the data contract

Write `docs/CONVERSATION-FORMAT.md` and a representative fixture before connecting
storage to the runtime. Resolve the following in that document:

| Entity | Required information |
| --- | --- |
| Conversation | Format version, stable ID, creation time, revision |
| Message | Stable ID, sequence, timestamp, role, run ID, content, completion state |
| Run | Unique invocation ID, agent path, parent run ID, start/end state, outcome |
| Tool exchange | Assistant call ID, tool name, arguments, full returned message, execution state |
| Topic | Stable ID, title, parent topic ID, explicit message membership |
| Artifact reference | Stable ID, type, title, backing path or child run ID, originating message |
| Structural change | Operation ID, expected revision, change payload, resulting revision |

Agent paths identify configured roles; run IDs distinguish repeated invocations
of the same role. Message order is determined by sequence, not timestamps.

Proposed invariants:

- Original messages remain in chronological order. Topic edits change references
  and metadata, not the text or chronological position of earlier messages.
- Topic hierarchy is a tree with stable IDs; renaming or moving a topic does not
  break references. A message has one primary topic initially. Cross-topic links
  can be added later.
- Messages can temporarily be unassigned. Classification must never prevent
  saving user input or a model response.
- Transcript records retain the information needed for valid provider replay,
  including tool-call associations and supported opaque reasoning continuation
  fields. Do not interpret or summarize provider continuation payloads.
- Persist the effective model and relevant configuration provenance for each run.
  On resume, use the current validated configuration and permissions; historical
  metadata never restores authority or session approval decisions.
- Preserve child transcripts under their own run identity. The parent receives
  the existing structured child result, not the child's entire context.
- Artifact references live in the Markdown. Large artifact contents stay in
  referenced files or directories; a missing backing file is a visible missing
  artifact, not a reason to discard the conversation.
- Artifact references grant no filesystem or execution permissions.

### 1.2 Choose and document the Markdown encoding

Proposed approach: a versioned document containing ordered records, readable
message bodies, and explicit machine-readable metadata. Represent topic changes
as revisioned operations so reorganization does not require relocating messages.
The exact syntax must be specified and covered by fixtures before implementation.

The encoding must handle arbitrary Markdown, code fences, HTML comments, Unicode,
and text that resembles record delimiters. Use explicit framing or escaping;
do not parse message boundaries by looking for ordinary headings. Document byte
encoding, newline handling, incomplete trailing records, and unknown versions.

Provide an example containing:

1. A user message and assistant response.
2. An assistant tool call and matching tool result.
3. Two topics with a nested subtopic and a rename operation.
4. A child run with a parent transcript artifact reference.
5. A document artifact backed by a relative path.
6. A cancelled or interrupted run.

### 1.3 Implement the pure format layer

Suggested modules under `core/src/conversation/`:

- `types.ts`: provider-independent document and record types.
- `format.ts`: parser and serializer, with useful location-aware diagnostics.
- `validate.ts`: identities, references, hierarchy, ordering, and exchange checks.

Keep filesystem writes and model calls out of this layer. Export supported APIs
through `core/src/index.ts`; keep the CLI on Core's public boundary.

### Acceptance checks

- Parse → serialize → parse preserves all supported semantic data and opaque
  provider payloads; original message content survives exactly.
- Fixtures cover LF/CRLF, Unicode, nested fences, delimiter-like content, invalid
  references, duplicate IDs, topic cycles, and unsupported format versions.
- A readable diagnostic identifies a malformed record without silently dropping it.
- Topic changes preserve message IDs, original bodies, order, and artifact links.

## Part 2 — Add persistence and resume

### 2.1 Implement one conversation service and store

Add a store and service under `core/src/conversation/`. All CLI, runtime, topic,
and future graphical-client mutations must pass through this service. Do not let
each client edit the Markdown independently.

Proposed project layout:

```text
.sfagents/
  conversation.md       authoritative conversation, topics, artifact references
  artifacts/            optional managed artifact files
  cache/                disposable indexes, if needed
  conversation.lock     transient writer ownership
```

Default `start` to this project's continuous conversation, with an explicit path
override and an ephemeral option for tests or temporary use. Ignore local state
in Git by default. Keep `run` ephemeral unless the caller explicitly selects the
persistent conversation. Document these choices and the exact flags before coding.

Use a single-writer lock across processes plus revision checks. A second writer
must receive a useful error rather than overwrite history. Define stale-lock
recovery without assuming that every old lock is abandoned. Reject unexpected
external changes while writing; allow validated manual edits while closed.

Specify the durable commit boundary, flush behavior, and bounded loss window.
Use complete framed appends or an atomic replacement strategy with explicit
Windows behavior. Any temporary recovery files must be transient; Markdown
remains authoritative. Storage failures must be reported and stop further
side-effecting execution when its intent cannot be recorded.

### 2.2 Connect persistence to runtime message boundaries

Add an awaited persistence hook or conversation-service integration at the places
where the runtime actually accepts and completes messages. Do not reconstruct
durable history by scraping terminal output or recording only text deltas.

Persist:

- Accepted user input before starting its model request.
- Run start, effective configuration provenance, and completed provider messages.
- Tool-call intent and execution start before executing a tool; its full result
  and terminal status after execution.
- Child run messages, outcomes, and their links to the parent invocation.
- Run completion, cancellation, provider failures, and interruption metadata.

Streaming text can remain transient until a defined checkpoint. If partial output
is saved, mark it as incomplete; never replay a fragment as a completed assistant
message. Test recovery at the actual checkpoint boundaries.

### 2.3 Recover conservatively

On reopening a conversation:

1. Validate the format and reconstruct committed state.
2. Identify unfinished runs and incomplete trailing writes. Preserve recoverable
   content and report damage; do not silently truncate a damaged document.
3. Mark prior active work as interrupted. Do not automatically repeat model
   requests, shell commands, file mutations, or MCP calls.
4. Distinguish calls that never started from calls with an unknown outcome. A
   missing result does not prove a side effect failed.
5. Build a protocol-valid working context. Where needed, synthesize an explicitly
   labeled interruption result for an unresolved call and record its provenance.
   Keep that distinct from an observed tool result.
6. Continue only when a new user request is accepted.

### 2.4 Update CLI behavior

- `start` opens or creates the default persistent conversation and reports its path.
- Provide explicit persistent-path and ephemeral options for `start` and `run`.
- Make `/clear` a working-context reset recorded in the same conversation; it
  must not delete history or create an unrelated thread. Its earlier history
  remains available through deliberate retrieval.
- Do not persist `--yes` or “always allow” approvals across restarts.
- Flush or close the store through existing cleanup paths, including Ctrl+C.
- Rebuild the active system prompt from current validated configuration rather
  than blindly replaying an old system prompt.

### 2.5 Preserve isolation

Protect managed conversation state from direct edits through ordinary agent file
tools. Route changes through validated conversation operations. Treat the main
transcript as private to its conversation: children receive only their assigned
input and their own authorized history, not unrestricted main-thread retrieval.

Continue stripping provider credentials from child environments. Do not store
environment snapshots or authentication headers. Transcript content and tool
results may themselves contain sensitive material; keep the state local and
untracked rather than claiming it can never contain secrets.

### Acceptance checks

- Two separate CLI processes can have successive turns in the same conversation;
  the second remembers a fact from the first using a deterministic mock provider.
- Completed tool exchanges and supported reasoning continuation payloads survive
  restart without changing their meaning or breaking provider request structure.
- Crash injection before/after execution and before/after result persistence
  never automatically repeats a tool. Unknown outcomes remain explicit.
- Lock conflicts, stale locks, external edits, disk-write failures, malformed
  trailing records, and Ctrl+C have defined, tested behavior on Windows.
- A child transcript survives restart and remains linked to its parent.
- Ephemeral mode and existing one-shot CLI tests continue to work.
- `/clear` resets active context while preserving the stored conversation.

## Part 3 — Add semantic organization and retrieval

### 3.1 Implement topic operations over the same store

Provide validated service operations and expose model tools with these proposed
names. Final names should be settled in the format/API document.

| Operation | Behavior |
| --- | --- |
| `list_sections` | Return a bounded hierarchical index of IDs, titles, and membership counts. |
| `add_section` | Create a topic or subtopic and optionally assign existing messages. |
| `edit_section` | Rename, reparent, or change membership without editing message bodies. |
| `search_sections` | Search topic titles and metadata. |
| `search_conversation` | Search permitted transcript text and return bounded excerpts with IDs. |
| `fetch_section` | Retrieve ordered section content with pagination and explicit truncation. |

Validate parent IDs, message ownership, expected revision, and topic cycles.
Commit each structural change atomically. Keep deletion, topic merging, and
permanent generated summaries outside the first version unless separately specified.

These operations require conversation authority, not ordinary workspace access.
Add explicit grants through the strict agent schema, loader, and runtime registry;
default to the root conversation owner and preserve child subset checks. Do not
implicitly enable main-conversation access for every configured child.

### 3.2 Let the model maintain the hierarchy

Add root-agent guidance explaining when to create a topic, reuse an existing one,
rename it, or fetch its history. Persist incoming messages under the current topic
or as unassigned before any classification request. Permit later reassignment.

Start with model-invoked topic tools during normal turns. Avoid a compulsory
extra classification request for every message. A failed topic operation must
not lose a message or prevent a normal response. Tool-provided revisions let the
model retry a stale structural edit against current state safely.

### 3.3 Separate stored history from working model context

Introduce a context builder, rather than trimming `AgentSession.messages` in place.
The durable history remains complete; each provider request receives a selected
view of it.

The initial policy should include:

1. Current system instructions and available tool schemas.
2. The new user message and a configurable recent window of complete exchanges.
3. A bounded topic-title index, including ancestor relationships and stable IDs.
4. Explicitly fetched historical sections relevant to the active work.

Use a configurable input budget and reserve space for output, tool schemas, and
fetched results. Start with a documented conservative estimator where exact model
tokenization is unavailable; report estimates as estimates. Do not hardcode a
single provider's context-window size.

Preserve complete tool-call/result groups and required provider continuation
data. Do not insert an old tool result into a request without its associated
assistant call. Historical retrieval can instead appear as clearly labeled tool
output quoting source records. Store each new exchange once, even when old
content is included in many working contexts.

When recent content alone exceeds the budget, apply an explicit fallback: retain
required current exchange data, reduce optional history/index entries, and ask
for narrower retrieval or return a clear budget error. Never silently damage the
protocol or drop the current user request. For very large histories, paginate the
topic index rather than assuming every title fits.

### 3.4 Keep retrieval bounded and inspectable

- Begin with deterministic lexical search over permitted messages and topic titles.
- Return stable source IDs, excerpts, match counts, and pagination information.
- Bound query size, returned characters, and scanned work; support cancellation.
- Treat retrieved messages and file excerpts as historical content, not new system
  instructions. Retrieved text cannot widen tools or conversation permissions.
- If search offsets or indexes are cached, invalidate them on revision changes
  and prove they can be rebuilt from the Markdown.
- Expose a CLI inspection path for topic listing and section retrieval so behavior
  can be verified before a graphical frontend exists.

### Acceptance checks

- Topic create/rename/reparent/reassignment operations survive reopening; invalid
  references, stale edits, and cycles fail without partial changes.
- A deterministic provider finds a fact in an old topic using search/fetch while
  unrelated historical bodies are absent from its initial request.
- A topic rename changes the navigation index without changing message IDs or text.
- Context selection respects configured budgets, pagination, complete tool groups,
  and provider continuation requirements.
- A large synthetic history exercises bounded index output and selective fetching;
  routine requests do not include the full transcript.
- Child retrieval cannot expose the main conversation or another child's transcript
  without an explicit authorized grant.
- Removing disposable indexes does not change authoritative data or search results.

## Suggested implementation sequence

Each increment should build and pass relevant deterministic checks independently.

| Increment | Deliverable |
| --- | --- |
| 1 | Format specification, realistic fixture, and documented CLI/storage decisions. |
| 2 | Pure types, parser, serializer, validation, and round-trip tests. |
| 3 | Store/service, writer locking, revisions, and crash-recovery tests. |
| 4 | Runtime persistence, child transcripts, CLI reopening, and interruption handling. |
| 5 | Topic operations, explicit tool grants, search/fetch, and CLI inspection. |
| 6 | Context builder, budget policy, selective retrieval tests, and updated user docs. |

Run the full deterministic suite and import audit after runtime integration and
again at completion. Add targeted live provider checks for restart/replay and
historical retrieval when a test credential is supplied; do not assume an earlier
temporary credential is still available. Update the milestone report with actual
results, platform coverage, and remaining limitations.

## Final end-to-end demonstration

1. Start the CLI and discuss a project, then an unrelated topic.
2. Have the model organize those exchanges into a parent topic and subtopics.
3. Run a file tool and delegate one bounded lookup to a child.
4. Close the process and reopen the same conversation.
5. Ask about an older fact. Show that the initial request contains the topic
   index and recent context, then the model fetches the relevant historical section.
6. Inspect the stored child transcript and artifact reference.
7. Interrupt a tool run and reopen again. Show the interrupted state without
   automatically repeating the tool.

Completion means this demonstration works with the existing CLI, all authoritative
conversation structure is recoverable from the Markdown, and future navigation
and artifact rendering can consume the same Core service.
