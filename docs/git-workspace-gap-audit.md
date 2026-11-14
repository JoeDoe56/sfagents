# Git workspace: GitHub Desktop gap audit

Built: repository dots, window (Changes/History), per-file inclusion, commit, discard, branch switch/create, fetch/pull(ff-only)/push/publish, merge + conflict resolve/continue/abort, undo, revert, clone/init (API), PR list/create, repository lock.

Gaps / not done:
- Partial (hunk/line) selection and the mixed checkbox state.
- Branch comparison UI ("Compare branch") and base/destination merge picker: API exists (compare), no UI; merge/branch prompts use browser prompt().
- Clone/init have API routes but no window UI or folder picker; new repos are not added to an agent's access config.
- Worktree labels on edge dots; narrow-screen pane navigation; keyboard-open reachability.
- Open file in editor, per-file context menu, discard recovery facility.
- Remote add/configure, diverged-history reconciliation flow beyond an explanation, last-fetch time.
- PR status/checks/merge actions; PR inspection beyond listing.
- Commit-draft revalidation after lock clears; selection is by file, validated by the server.
- Not tested in a browser.
Deferred by brief: stash, amend, cherry-pick, rebase, tags.
Out of scope without decision: history rewriting, hosting admin, issues.
