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
