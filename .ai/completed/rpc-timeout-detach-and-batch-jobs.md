# RPC timeout: detach instead of cancel, and job-based batch updates

Status: DONE
Started: 2026-10-28

## Steps
- [x] Detach on timeout in the RPC client and update the transport tests
- [x] Add the batch update job registry with its tests
- [x] Expose start/get/cancel job RPCs and share the batch implementation in host-api
- [x] Switch updates-view to start + poll and update its tests
- [x] Verify: esbuild, lint, focused tests, full suite; update CHANGELOG

## Notes
- `npm test` — 410 passing; esbuild, lint and test-compile clean.
- Deferred: `updateProjectAsync`, `consolidatePackagesAsync`, `cleanupUnusedPackagesAsync` have the
  detach fix but not the job registry yet.
