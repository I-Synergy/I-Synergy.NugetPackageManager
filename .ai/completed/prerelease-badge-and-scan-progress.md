# Prerelease badge and scan progress

Status: DONE
Started: 2026-10-26
Plan: `.ai/plans/prerelease-badge-and-scan-progress.md`

## Steps
- [x] Types: ScanId + scan progress RPC
- [x] Host scan-progress registry
- [x] Host reports progress + new handler
- [x] Updates view: progress polling + badge-changed
- [x] Packages view: prerelease badge refresh
- [x] Tests
- [x] Verify (esbuild, lint, tests)

## Notes
- Badge root cause: a Prerelease toggle only refreshed the count through a mounted
  `updates-view`; the tab badge kept the old number and the Activity Bar badge
  (`updateBadgeAsync`) was never updated by a scan at all.
- `updates-view` now emits `badge-changed` (count + blocked count) and `scan-finished`.
- `ScanId` + `getOutdatedScanProgressAsync` stream stage/percent/counts; the
  Updates tab polls every 400 ms and renders a determinate progress bar.
- Verification: `npm run esbuild`, `npm run lint`, `npm test` — 395 passing.
