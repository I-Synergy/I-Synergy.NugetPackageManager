# Long mutations as host jobs: project update, consolidate, cleanup

Status: DONE
Started: 2026-10-28

## Steps
- [x] Generalize the job registry (JobRegistry + OperationJobs) and its tests
- [x] Add start/get/cancel job RPCs for project update, consolidate and cleanup
- [x] Extract the three host implementations with progress reporting
- [x] Add src/web/jobs.ts and convert updates-view, project-row, packages-view, consolidate-view, cleanup-view
- [x] Update component and host tests
- [x] Verify: esbuild, lint, test-compile, full suite; update CHANGELOG/README/session context

## Notes
- `npm test` — 421 passing; esbuild, lint and test-compile clean.
- `restoreProjectsAsync` intentionally left on the single-call path.
