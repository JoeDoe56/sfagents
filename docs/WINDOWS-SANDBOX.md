# Windows shell sandbox

The Windows backend is `core/native/windows-sandbox`, a Rust helper built as
`core/native/bin/win-x64/sfagents-sandbox.exe` (or `win-arm64`). A missing helper,
incomplete setup, failed logon or failed network check refuses shell commands.
There is no unsandboxed fallback.

## Build and setup

Source builds need Rust and the Visual Studio C++ Build Tools / Windows SDK.
Packaged installs include the helper and do not need Rust. `npm run build` and
`npm install` build it when the toolchain is available; packaging should set
`SFAGENTS_REQUIRE_SANDBOX=1` to make a missing build fatal.

```powershell
npm run build:sandbox
npm run sandbox:setup
```

Setup requests UAC. It creates two dedicated standard users, `sfagents_sandbox`
and `sfagents_sandbox_net`, with random passwords held in the installing user's
Credential Manager. Passwords never enter a command line or a policy file.
The accounts receive local logon rights and the quota privilege needed by the
trusted worker; they are denied remote, batch and service logons. They are not
administrators. Setup registers their Windows profiles for known-folder APIs;
command home and temporary data still use disposable directories. Group policy
that denies local logon can prevent their use.

Only setup and uninstall elevate. Commands must run from an ordinary terminal.
The installation belongs to the installing Windows user; these are local
machine accounts, not an installation to share between different Windows users.

Setup adds per-user firewall rules and persistent Windows Filtering Platform
blocks for the offline account. The filters cover IPv4, IPv6 and loopback,
independently of an executable's name. `workspace.network: true` chooses the
second account. It does not lift the offline account's rules.

The sandbox accounts cannot list or read file contents in personal profiles, ProgramData and
other fixed/removable drives. `C:\ProgramData\Git` is the only ProgramData
exception. Python's all-users installs at `C:\PythonNNN` are runtimes, not
personal data, and stay readable (Windows grants Users read there), so virtual
environments that point at them work. New drives, profile folders or extra
folders at `C:\` cause commands to refuse until setup refreshes those protections. Workspaces must be on C:;
system folders and the collection of user profiles cannot be workspace roots.
Metadata and traversal permissions let runtimes resolve explicitly granted
paths without opening personal file contents. A dedicated restricting SID has
read/write access to the null device (for shell redirection to `NUL`) and the
named-pipe device (for local pipe creation). Existing pipes retain their own
access checks. These device permissions are checked before each run; if Windows
recreates a device after reboot, commands refuse until `sandbox:setup` refreshes
the grant. Reboot persistence has not been verified.

## Commands and recovery

The helper applies the canonical policy's file permissions before starting a
command, and leaves them in place afterwards: the next command with the same
policy (the same agent's folders) starts at once instead of re-applying
recursive permissions to the whole workspace. A command with a different policy
first revokes them (once no command of the old policy is running) and applies
its own. Workspace roots can be changed; `read` rules deny changes and `none`
rules deny access. More specific rules override inherited parent permissions.
Guard ancestors cannot be renamed to replace a protected path. Modify grants
exclude the permission to delete arbitrary children regardless of their ACLs.
If a workspace contains the native helper, the helper is always read-only and
its ancestors are protected against replacement.

A worker logs on as the selected account and creates the command with a
write-restricted token, with privileges disabled, a fresh restricting SID for
the run's own objects and the policy's restricting SID, which the workspace
write grants name.
It runs on a private window station/desktop. The unrestricted worker's process
and token DACLs deny access from the command, including owner rights.
The session's named-object directory receives a non-inheriting grant for the
run, so runtimes can create kernel synchronization objects. This grants no
access to existing objects or to filesystem trees. Recovery preserves permanent
setup entries when a temporary entry shares a path and account SID.

A Job Object contains the worker and all command descendants. Closing the
broker or ending the command kills its background processes before permission
cleanup. Processes meant to outlive a command (dev servers, watchers) are run
with the shell tool's `background: true`: the command's broker then stays
alive with it, and stopping the job or quitting SF Agents ends it. The run has an empty disposable home and temp directory. Only usable
PATH entries and locale variables cross from the host; provider credentials,
host profile paths and runtime injection variables do not. Git trusts the
granted roots for that process only, so status/commits work under a different
account without changing global Git configuration.

A machine-wide mutex is held while permissions change, not while commands run.
Commands with the same policy run side by side. A command with a different
policy waits up to 25 seconds for the running ones (background jobs included)
to end, then reports that the sandbox is busy. This prevents two policies from
combining the dedicated account's permissions. The policy's standing
permissions are journaled in `%LOCALAPPDATA%\SF Agents\sandbox\standing.json`
and each run's own (its temp folder, pipe, namespace grant) in
`runs\run-<id>.json`, next to a lock file the live broker holds open. A
canceled/killed broker's Job Object kills its descendants; `recover` replays the
cleanup of every run whose broker is gone, and `recover --all` (or uninstall)
also revokes the standing permissions. The TypeScript adapter invokes recovery
after every run, and the next run also recovers before applying permissions.
The broker writes a marker line to stderr when the command starts; the shell
tool's timeout counts from there, so a slow first permission setup does not
use up a short timeout. An incomplete cleanup retains the journal and refuses
later commands. Do not delete that journal to bypass a cleanup error.

`sf-web` uses a unique local named pipe. Only the selected sandbox account and
the run's restricting SID are granted access. The native broker creates the
Windows command shims; the host still holds the web provider key and enforces
the existing quota, argument, size and time limits.

Permission inheritance is recursive. First setup, and the first command after
switching to another agent's policy, can take a while in very large workspaces
(about 30-50 seconds for a folder of many projects); keep roots as narrow as
practical.

## Runtime compatibility

Windows PowerShell 5.1's .NET Framework runtime cannot create its legacy private
debugging IPC block with the restricting SID. It fails with `80070005` before
the script runs. The helper reports the failure and suppresses modal startup
dialogs. Use `cmd`, Node, or compatible native tools for sandbox commands.
PowerShell 7 uses modern .NET. On the test PC it passed that initialization but
failed loading `BCrypt.dll` with `0x8007045A`. Neither PowerShell version is
currently supported inside the sandbox. No cryptography device ACL was changed.
The user's interactive terminal and host-side setup scripts are unaffected.

Node file operations and direct Git commands through `cmd` work. Node subprocesses
with captured/piped standard streams currently fail with `EPERM`: Windows gives
those new pipes a default DACL without the restricting SID. Subprocesses using
`stdio: 'ignore'` work and remain in the Job Object. This also limits tools such
as npm that launch children with pipes. The helper does not broaden the
restricting token or retry failed programs outside isolation.

## Undo

```powershell
npm run sandbox:uninstall
```

Uninstall requests UAC, recovers any pending run, revokes the managed SID entries,
removes the firewall/WFP rules and account logon rights, deletes the two managed
accounts and their profiles, and removes their Credential Manager entries. It
refuses to delete an account whose SID differs from the installation journal.
Uninstall verifies removal of both allow and deny entries before recording each
completed path. A failed cleanup retains the remaining journal so it can be retried.

## Verification

Without installing anything:

```powershell
npm run typecheck
node scripts/run-tests.mjs windows-sandbox sandbox
cargo test --locked --manifest-path core/native/windows-sandbox/Cargo.toml
```

After explicitly approving and running setup, in an ordinary terminal:

```powershell
$env:SFAGENTS_TEST_WINDOWS_SANDBOX = '1'
node scripts/run-tests.mjs windows-sandbox-native
```

The native suite uses disposable folders under the checkout's `.tools`. It
checks quotes/Unicode, workspace reads and writes, Git status/commit, protected
paths and rename attempts, nested access rules, offline Internet/loopback versus
network opt-in, `sf-web`, timeout/cancellation, and background process cleanup.
Uninstall and subsequent reinstall are separate explicit lifecycle checks.
