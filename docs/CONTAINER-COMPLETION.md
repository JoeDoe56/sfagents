# Container workflow completion

2026-11-03. Work remains on `docker`; `main` is not merged.

## Shipped behavior

- The editor core can create the first agent without loading an agent tree (`loadAgentEditor`).
- Pull Requests is a working, optional setting, off by default. Draft creation, check/review refresh, feedback delivery to the workspace's agent, and SHA-checked merge are available in the web sheet and TUI. A Merge click can mark a draft ready. The agent has `sfa-git pr open|status`; merge is a person action.
- CI results and PR check state persist with workspace metadata and appear on task pills. Changing the worktree marks old results stale. A CI run with no workflow is recorded separately from a pending run.
- Only a main run can request a full-control lease. A one-time approval card is required, including with `--yes`. The lease ends at idle, Stop, timeout, or runtime disposal. Its cancellation signal reaches host commands and host UI calls. Each model step receives the remaining time on its newest message, so the system prompt stays cacheable.
- The web banner and TUI countdown expose Stop. Full Control Files in the agent sheet and `/full-control` in the TUI expose history, file changes and undo. Snapshot checksums and later-edit checks protect undo. SF Agents' own configuration/history, credential files, dependencies and symlinks are excluded. File rollback cannot undo app transactions.
- Every agent has `sfa-ui` on its own container desktop, independently of host full control or network level. `--host` requires the main run's active lease. Windows host UI uses UI Automation patterns, PrintWindow and an explicit SendInput coordinate fallback. Container UI uses Xvfb, Openbox, D-Bus and AT-SPI. Chromium accessibility is enabled both on the desktop bus and in the renderer.
- Agent desktops start with their containers; UI calls wait for both D-Bus and the display. Node uses the same environment proxy as the other language tools. Network edits apply to the next command in an active run and close existing outgoing tunnels, while preserving local SF Agents command channels and web quotas.
- Text is supplied by the calling agent; the decision model only selects. If an advertised text pattern fails, the container driver verifies that failure and uses keyboard input on the focused control. Nothing in an agent's own container desktop asks the person (it may type passwords it was given). On the host, buttons that send, delete, submit, pay or publish ask through a one-time card, host passwords are entered by the person directly in the app, and coordinate clicks do not ask.
- The StartLux loop has a 0.8 confidence gate, rejects a high none-of-the-above score, retries with a screenshot, verifies changes and DONE, and returns the goal/tree/screenshot/history to the calling agent on uncertainty. Control choices use short numbers, with window/dialog context to distinguish duplicate names.
- The first-use installer is private to the SF Agents home. Model/projector and GPU runtime archives are checksum checked. The source engine and tokenizer revisions are pinned. UI workers are shared across concurrent tasks and released when unused. Speech moves to CPU only when GPU headroom is insufficient.
- Git helper commands disable repository hooks and filesystem-monitor programs. Clone URLs cannot contain embedded credentials. Provider shutdown closes inherited Windows pipes so tests and sessions can exit.

## Verification

Final Windows `npm test`: **311 passed, 24 skipped, 0 failed** (335 tests). The final focused verification also passed, including the real host-command cancellation and web approval/undo round trip. Live network-edit tests cover already-built tools, preserved web quotas and command channels, tunnel revocation, and revocation during DNS lookup.

Final Linux `npm test`: **373 passed, 4 skipped, 0 failed** (377 tests), in a disposable container on the SF Agents-owned engine. This included the Unix container stand-ins, bundled sensor runtime, real X11 keyboard hook and terminal tests. Speech-model downloads were disabled for this test run with `SFAGENTS_SKIP_SPEECH=1`; the test workspace/container/home were removed afterwards.

Run `npm test` on Windows or Linux. Container stand-in suites are skipped on Windows because they require Unix process groups. Tests use disposable settings and keyring service names. Test temp folders should be outside this repository: nesting them inside a dirty checkout makes the diff discovery tests legitimately find the parent checkout.

New tests cover empty-agent creation, PR enablement/checks/reviews/SHA-checked merge, credential handling, lease ownership and expiry, Stop during a real host command, rollback conflicts, and a complete web approval → host shell → banner → review → undo round trip. UI tests cover supplied text, DONE verification, screenshot retry/handoff, password approvals, unsupported actions and native failures.

Real tests used the SF Agents-owned WSL Docker engine; WSL was never shut down and Docker Desktop was not selected.

| Project | Source | Checks |
| --- | --- | --- |
| sfgl | `dc50353`, `Claude/testing1` | 55 unit tests, build, and 9 browser scenarios passed. The source branch has existing type-check errors, recorded separately; app source was not changed to hide them. |
| DebriPod | `87dc9d2`, `codex/testing3` | 23 search-route, UI-settings and server-session tests passed. A scratch fixture used an in-memory keyring and a container-only database; no Windows keyring or real account was used. |
| Container UI | Same scratch workspaces | Opened an editor, changed text and captured its window. StartLux opened and verified sfgl Settings; an uncertain close request handed back, and the main agent closed the correct sheet. StartLux changed DebriPod's Username to a supplied value and verified it, without creating an account or entering a password. |
| Windows UI | Temporary WPF form | Set text through ValuePattern, invoked its button, verified the resulting label and captured the window through PrintWindow. The fixture was closed afterwards. |
| Git workflow | Both scratch branches | Applied patches, checkpointed, reviewed, undid the checkpoint, reapplied, and squashed to clean commits. Neither branch was pushed or merged. |

The scratch commits were `57c2e64` (sfgl) and `25cf7cc` (DebriPod). Incremental bundles and screenshots are retained in the ignored `.test-temp` folder. The two `/workspaces/sfa-e2e-*` clones, their task branches and the private test agent/container/home were removed after verification. The temporary GUI image and private model installation remain available for reruns.

## Runtime details and limits

The tested machine has a GTX 1660 Super. Model startup and image decisions take time on that GPU; this is not a latency guarantee. The 0.8 gate remains conservative after the requested app smoke tests. Ambiguity is an expected handoff, rather than permission to act on a low-confidence choice.

The automatic runtime is llama.cpp `b12073`, with an 8192-token context and an unsplit attention batch. The engine is StartLux commit `a99977d9332decc9fb27a2488b4a83b533b6cd5f`; the model is v1.1 4B Instant Q4_K_M. Thinking and prompt reuse are disabled by the StartLux backend. Stock llama.cpp warns that image prompts are split across modality batches; upstream's patch 0003 improves image parity. This limitation is retained explicitly, with the confidence/verification/handoff gates, rather than claiming the patched engine's accuracy. See the [upstream deployment documentation](https://github.com/StartLuxLabs/StartLux-Decision/blob/a99977d9332decc9fb27a2488b4a83b533b6cd5f/docs/engines.md#llamacpp).

Host UI driving on Linux and macOS remains the plan's later work. Container UI works through Linux AT-SPI on both Windows and Linux Docker hosts. macOS runtime support and a persistent voice agent are also later work.

The updated `ghcr.io/joedoe56/sfagents-agent:docker` image was built, smoke-tested and published by [Agent image run 41679390599](https://github.com/JoeDoe56/sfagents/actions/runs/41679390599). Pull that image, then Reset Environment for existing agents to recreate their containers from it. Existing legacy agent files with removed sandbox fields must be recreated in the editor. Merging `docker` into `main` still requires Caleb's separate instruction.
