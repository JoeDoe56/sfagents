# Git workspace: GitHub Desktop gap audit

Built: repository dots (all repositories any agent can reach), window (Changes/History), per-file inclusion, commit, discard, branch switch/create, fetch/pull(ff-only)/push/publish, add remote, last-fetch time, merge + conflict resolve/continue/abort, undo, revert, Compare branch in History, clone/init (API), PR list/create, repository lock enforced in the operation layer.

Gaps / not done:
- Partial (hunk/line) selection and the mixed checkbox state: selection is per file only.
- Clone/init have API routes but no window UI or folder picker; new repositories are not added to an agent's access config.
- Merge and branch prompts use the browser prompt(), not sfgl fields; no base/destination merge picker.
- Worktree labels on edge dots; narrow-screen pane navigation; keyboard-open reachability.
- Open file in editor, per-file context menu, discard recovery facility.
- Diverged-history reconciliation beyond an explanation.
- PR status/checks/merge actions; PR inspection beyond listing.
- Commit-draft revalidation after the lock clears; the server validates by file.
- Nothing has been tested in a browser.
Deferred by brief: stash, amend, cherry-pick, rebase, tags.
Out of scope without decision: history rewriting, hosting admin, issues.

## Update: accessible repositories, clone and init

- Accessible repositories come only from folders attached to agents (each folder and its direct subfolders). The config directory is no longer scanned and there is no separate setting.
- The More menu in the window now has "Create a repository in a folder…" and "Clone a repository…". The server only accepts paths inside an agent-attached folder.

## Checked

- Headless Chromium at phone and desktop widths: edge dots, hold and release, window, diffs, partial commit, push, History, conflict screens.
- API checks: init and clone, a refused path outside agent folders, binary and rename diffs.
- Unit tests: the busy lock refuses commits while an agent works on a repository (tests/gitapi.test.ts). The lock is released when a run ends.

## Not checked

- The busy lock with a real agent run (the test server has no provider).
- Pull request creation against GitHub.
- The keyboard-open layout and the feel on a real phone.
- The single-file diff shows a rename as delete plus add.
