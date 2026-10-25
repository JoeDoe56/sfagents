# Windows shell sandbox: handover

Status on 2026-10-25: implemented and tested on Windows x64, with the runtime
limitations below. The original scaffold has been replaced by the restricted
account backend. See [setup, design, recovery and undo](WINDOWS-SANDBOX.md).

## Confirmed behavior

- System folders are readable; personal file contents, ProgramData (except
  `C:\ProgramData\Git`), and other fixed/removable drives are hidden.
- Commands write only policy grants and disposable home/temp data. Longest-path
  rules support writable, read-only and hidden subtrees. `.env` and `.sfagents`
  are hidden; agents, mcp.json and Git configuration/hooks/modules are protected.
- The default account is offline, including loopback. `workspace.network: true`
  selects the separate online account. `sf-web` uses the host's private pipe and
  never puts provider credentials into the sandbox.
- Setup and uninstall request UAC; commands and recovery run unelevated. Missing
  setup, failed checks or incomplete cleanup refuse commands. No unsandboxed retry.
- Setup must have the user's explicit approval before machine changes. Undo is
  exactly `npm run sandbox:uninstall`. The user approved setup, native isolation
  tests, uninstall/cleanup verification and reinstall for this implementation.
  The user separately approved the named-pipe device grant only; KsecDD remains
  untouched.
- Commits have no co-author/session trailers. Commit in logical pieces and push
  to main, as requested.

## Implementation map

- `core/src/sandbox/windows.ts`: synchronous wrapper, prepared policy JSON,
  helper detection, and recovery after every run, including timeout/cancellation.
- `core/native/windows-sandbox/src/setup.rs`: two standard accounts, registered
  Windows profiles, Credential Manager passwords, logon policy, persistent ACLs,
  fail-closed coverage checks, setup journal and uninstall.
- `network.rs`: persistent WFP blocks for the offline SID on the four IPv4/IPv6
  connect/receive layers, supplementing the per-user firewall rules.
- `runner.rs`: temporary policy ACL journal, unique restricting SID,
  write-restricted token with disabled privileges, private desktop/window station,
  protected broker process/token, sanitized environment, Job Object containment,
  parent-death handling and permission recovery.
- `win.rs`: Windows handles, SID/ACL primitives, machine mutex and permanent ACL
  restoration. `model.rs`: protocol, path precedence and command-line quoting.
- `scripts/build-sandbox.mjs`: MSVC build, source-hash cache and dependency notices.
  Build output is ignored under `core/native/bin/win-x64` or `win-arm64` and is
  included by the core package. `prepare` builds it when a toolchain is present;
  packaging can require it with `SFAGENTS_REQUIRE_SANDBOX=1`.
- `scripts/windows-sandbox.mjs`: explicit hidden UAC wrapper for setup/uninstall.
  Passwords never enter argv, scripts or policy JSON.

The per-command account ACLs are serialized by a global mutex; a wait exceeding
25 seconds reports busy. First setup/uninstall propagates inheritable ACLs and
can take several minutes on a large profile. Recovery restores permanent entries
when a temporary grant shares their path/SID. It retains failed cleanup journals.
The named-pipe and null device grants are checked before each run; Windows may
recreate those objects after reboot, requiring an explicit setup refresh.

## Verification on this PC

- Rust tests: 7 passed, including preservation of permanent allow/deny entries
  during recovery, removal of both ACE types, partial-setup pipe cleanup, and
  protecting the helper inside a workspace.
- Native isolation suite: 9 passed, 1 skipped (no second writable drive available).
  Covers quotes/Unicode, empty home, workspace writes, Git status/commit, hidden
  secrets/personal data/ProgramData, system-write denials, guard replacement,
  nested rules, offline Internet/loopback, online loopback/HTTPS, host-only
  `sf-web` and quota, timeout/abort, descendants, parent death, helper replacement,
  recovery, and making a previously read-only path writable under a new policy.
- Typechecking and the import/dependency audit pass.
- Uninstall audit: accounts, profiles, credentials, firewall/WFP objects and
  pending journals absent; no managed entries on 32 checked ACL paths. A separate
  approved cleanup removed four historical diagnostic capability deny entries;
  six paths were checked and unrelated PowerShell runtime entries stayed intact.
- Reinstall completed and the native suite passed against the fresh accounts.
- Full deterministic suite before merging `usage-bar`: 220 passed, 2 skipped,
  0 failures. Windows portability fixes cover configuration paths, file-service
  fixtures, shell commands and line endings. A provider-cache regression now
  checks atomic file replacement with the same timestamp and size.
- After merging `usage-bar`, the full suite with native isolation enabled:
  233 passed, 3 skipped, 0 failures. The provider-cache regression uses a second
  process; the Codex mock closes pooled HTTP sockets so its worker exits. The
  online sandbox HTTPS check allows 15 seconds for the external endpoint.
- Browser verification with an isolated mock provider confirmed the five-hour
  and weekly usage bars, reset captions, and live usage refresh without console
  errors. The optional Windows Codex binary is installed. Package installation,
  build and typechecking completed successfully after the merge.

Run the repeatable native suite only after approving and installing setup:

```powershell
npm run build:sandbox
npm run sandbox:setup
$env:SFAGENTS_TEST_WINDOWS_SANDBOX = '1'
node scripts/run-tests.mjs windows-sandbox-native
```

## Runtime limitations and follow-up checks

`cmd`, direct Git commands, Node file operations, and Node subprocesses using
`stdio: 'ignore'` work. Windows PowerShell 5.1 fails its legacy CLR IPC check
(`80070005`). PowerShell 7 passes that check but failed `BCrypt.dll` startup on
this PC (`0x8007045A`). Node subprocesses with captured/piped stdio fail with
`EPERM`, because their new pipes' default Windows DACL omits the restricting SID.
This limits tools such as npm inside the sandbox. These failures do not relax
permissions or trigger a retry outside the sandbox.

Keep the filesystem boundary when investigating runtime support: adding Everyone
or the account SID to the restricting set would defeat the write restriction.
Do not add device permissions without evidence and the user's explicit approval.
No cryptography-device grant was applied. Other-drive isolation and device ACL
persistence across reboot remain unverified on this PC. ARM64 packaging and
enterprise logon-policy variations need their own machines.
