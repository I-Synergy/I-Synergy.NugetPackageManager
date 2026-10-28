# Batch update: preflight conflicts, single restore, attributed retry, live progress + cancel

Status: DONE
Started: 2026-10-28

## Steps
- [x] Add wire types for conflicts, cancellation and the check RPC
- [x] Implement findBatchUpdateConflictsAsync + checkBatchUpdateAsync
- [x] Pass --no-restore for non-CPM rows inside a transactional batch
- [x] Attribute restore failures to batch rows (ConflictingPackages)
- [x] Stream restore progress (TaskExecutor + restoreProjectsInternalAsync) and mark Cancelled
- [x] Web: onStarted, Cancel button, conflict confirm, retry-without-culprit
- [x] Tests: host preflight/restore/cancel/progress, web confirm/cancel
- [x] Verify and update docs

## Notes
- `npm test` — 431 passing; esbuild, lint and test-compile clean.
- Preflight needs `obj/project.assets.json`; without it, one-update selections are skipped and
  only multi-package self-conflicts can be reported.
- A transitive blocker keeps the graph's lowercased id (no project-file casing to borrow).
- Follow-up done: Cancel is available on a busy `project-row`, on a consolidating card, during cleanup and during "remove from all projects" (which stops the per-project loop). Tests: 434 passing.
