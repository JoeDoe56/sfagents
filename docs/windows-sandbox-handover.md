# Windows shell sandbox: handover

Status on 2026-10-25: **not built**. On Windows the shell tool still refuses every command (`detectSandbox()` in `core/src/sandbox/sandbox.ts` returns `ok: false` for `win32`). This file is the plan, along with what has been decided and what is already in the repo. Linux (bubblewrap) and macOS (Seatbelt) backends are done. Use them as references.

## What is in the repo

- `core/native/windows-sandbox/`: a Rust crate scaffold (`sfagents-sandbox`). `main.rs` only answers `version`. `Cargo.toml` already lists `windows-sys` 0.59 with the features below, plus `serde` and `serde_json`. `Cargo.lock` is committed.
- Cross-compiling from Linux works:
  `rustup target add x86_64-pc-windows-gnu`, `apt install gcc-mingw-w64-x86-64`, then
  `cargo build --release --target x86_64-pc-windows-gnu` in that folder.
- Nothing has run on the Windows PC yet. There are no accounts, firewall rules or ACL changes to clean up.

## The interface to implement

`core/src/sandbox/sandbox.ts`:

```ts
interface Sandbox { readonly name: string; wrap(command: SandboxCommand, policy: SandboxPolicy): WrappedCommand }
```

`wrap` is synchronous and returns the command that Node spawns, plus an optional `cleanup()`. On Windows it should return the helper: `sfagents-sandbox.exe run --policy <temp.json> -- <shell exe> <args...>`, with `cleanup` deleting the temp file. Add `core/src/sandbox/windows.ts` with `WindowsSandbox` and `detectWindowsSandbox()` (it runs `sfagents-sandbox.exe probe`), and add a `win32` branch to `detectSandbox()`.

The policy comes from `buildSandboxPolicy` (`core/src/sandbox/policy.ts`). Its `rules` are `{path, access: write | read | none}`, longest prefix wins. The workspace roots are `write`. Guards inside them are `.sfagents/` and `.env` = `none`, `agents/` and `mcp.json` = `read`, and `.git/hooks`, `.git/config`, `.git/modules` = `read`. The rest of `.git` stays writable. `prepareRules()` creates missing guarded paths, so they can be protected.

Binary location: build to `core/native/bin/win-x64/sfagents-sandbox.exe` (ignored by git, built by a script like `scripts/build-sensors.mjs`, hooked into `prepare`). Resolve it from `core/dist/sandbox/windows.js` with `new URL('../../native/bin/win-${process.arch}/sfagents-sandbox.exe', import.meta.url)`.

## Caleb's confirmed rules

1. System folders are readable. The user's profile and personal files are hidden.
2. **Drives other than C: and `C:\ProgramData` are hidden** (deny-read for the sandbox accounts). The only exceptions are the few ProgramData subfolders that common tools need, such as Git for Windows' system config. Keep that allowlist short and in one place.
3. Offline by default. Per agent, `workspace.network: true` turns the network on.
4. No approval prompt once sandboxed (`tools.ask` turns it back on). With no sandbox, every command is refused.
5. One UAC prompt, at setup only. The per-command path must run unelevated.
6. Before anything runs on his PC that changes the system (accounts, firewall, ACLs, UAC), ask him first, and give him the exact undo (`sfagents-sandbox uninstall`).
7. No Claude co-author or session trailers on commits. Commit in logical pieces and push to main.

## Planned design (worked out, not implemented)

**Two local accounts**, created by `setup`: `sfagents_sandbox` (offline) and `sfagents_sandbox_net` (network allowed). A firewall rule that blocks outbound for one user SID cannot be lifted for a single run, so network opt-in picks the second account. Both are standard users with no admin rights and random passwords. Create them with `NetUserAdd` rather than `net user`, so the password never appears on a command line. Store each password in the invoking user's Credential Manager (`CredWriteW`, generic credential, targets such as `sfagents/sandbox` and `sfagents/sandbox-net`). UAC elevation keeps the same user SID, so the unelevated `run` can read them with `CredReadW`.

**Setup (elevated, idempotent):**
- Create or refresh the two accounts and their stored passwords.
- Give the accounts the logon right that `CreateProcessWithLogonW` needs. Group policy that removes "log on locally" is a known failure mode, so report it clearly.
- Add a per-user outbound block rule for `sfagents_sandbox` only, e.g. `New-NetFirewallRule -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;<SID>)"`.
- Add persistent deny-read ACEs for both accounts on the other fixed drives and on `C:\ProgramData`, with the allowlisted subfolders granted back. These are machine-wide, so they belong in setup, not in each run.
- `uninstall` reverses all of the above: removes the ACEs, the firewall rule, the accounts and the stored credentials.

**Run (unelevated, per command):**
1. Read the policy JSON and pick the account from `network`.
2. Apply ACEs for that account's SID. `write` roots get an inheritable grant of modify rights. `read` guards get a deny-write ACE (all the write, delete and change-permissions bits). `none` guards get a deny-all ACE. Use `GetNamedSecurityInfoW` → `SetEntriesInAclW` → `SetNamedSecurityInfoW`, which places deny ACEs before allow. The workspace is Caleb's, so he can change its DACL without elevation.
3. Build the account's own environment, so Caleb's `USERPROFILE`, `APPDATA` and the like don't leak. Call `LogonUserW` to get a token, then `CreateEnvironmentBlock`. A NULL environment would inherit Caleb's.
4. Launch with `CreateProcessWithLogonW` (`LOGON_WITH_PROFILE`, `CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT`, cwd = workspace). This works from an unelevated process. `CreateProcessAsUserW` would need SeAssignPrimaryToken, which a normal user doesn't have.
5. Put the process in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, resume it, wait, and pass the exit code through. Pipe stdout and stderr through the helper.
6. Cleanup: revoke that SID's ACEs on the policy paths (`REVOKE_ACCESS`; only this helper ever grants these SIDs there).

**Hardening that is still open:**
- Restricted token: with `CreateProcessWithLogonW` the helper cannot pass in a token from `CreateRestrictedToken`. Options are getting the rights for `CreateProcessAsUserW` at setup (this changes Caleb's own account, so ask him first) or having the first sandboxed process re-launch itself with a restricted copy of its own token.
- Private desktop: `CreateDesktopW` per run, let the account use it, and set `STARTUPINFOW.lpDesktop`. Make it best effort.
- Speed: inheritable ACEs propagate through the whole tree, which can be slow on big folders (node_modules). Measure on the PC. If it's slow, apply them once per workspace and keep them.
- Web access (`sf-web`) on Windows: `host-channel.ts` listens on a Unix socket path. Windows needs a `\\.\pipe\...` name that the sandbox account is allowed to open, and `policy.tools` added to its PATH. Untested.
- Agents' own environment variables aren't passed through, because the child gets the sandbox account's environment. Decide which variables to merge in, never secrets (`sanitizeChildEnv`).

## Tests to run on the PC

Run them through Remote Control on the default device, with folders under `C:\Users\bugma\projects`:
- Commands work in the workspace: write, read, git status, git commit.
- Reading `C:\Users\bugma\Documents`, `.env`, `.sfagents\`, another drive and `C:\ProgramData\<not allowlisted>` all fail.
- Writing `agents\x.json`, `mcp.json`, `.git\hooks\pre-commit`, `.git\config` and `C:\Windows\x` all fail.
- The offline agent can't reach the network (`curl https://example.com`). An agent with `network: true` can.
- A command that starts a background child is killed when the run ends or times out (Job Object).
- `uninstall` leaves no accounts, rules or ACEs behind.

Also add unit tests in `tests/sandbox.test.ts` for the TS side (`wrap` output, policy JSON) that run on any OS.
