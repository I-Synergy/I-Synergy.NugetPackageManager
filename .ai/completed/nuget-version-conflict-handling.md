# NU1107 / transitive version-conflict handling

Status: DONE
Started: 2026-10-26
Completed: 2026-10-26
Plan: `.ai/plans/nuget-version-conflict-handling.md`

## Steps

### Phase 1 — Restore diagnostics
- [x] Add `restore-diagnostics.ts` parser + formatter with tests
- [x] Wire structured restore result through `restoreProjectsInternalAsync`, `restoreProjectsAsync`, `batchUpdatePackagesAsync`
- [x] Surface the conflict chain in the Updates view / error text
- [x] Add host tests for NU1107 propagation and rollback

### Phase 2 — Transactional single update
- [x] Snapshot + rollback in `updateProjectAsync` (CPM and non-CPM)
- [x] Add host test proving the props/csproj is unchanged after a failed restore

### Phase 3 — Constraint-aware suggestions
- [x] Add `satisfiesVersionRange` + `version.test.ts`
- [x] Collect dependency constraints per TFM group in `getOutdatedPackagesAsync`
- [x] Cap `LatestVersion`, add `BlockedBy` + blocked list to types/UI
- [x] Add host + component tests

### Verification
- [x] `npm run esbuild`
- [x] `npm run lint`
- [x] `npm run test-compile`
- [x] `npm test` — 360 passing
- [x] README / CHANGELOG

### Out-of-repo
- [x] Verify `I-Synergy.Framework` net11 line and restore the sample — the working tree already had the rc.2 pins; `dotnet restore --force-evaluate` succeeds

## Notes

- Blocked updates are not silent: they render as a **Dependency conflicts**
  section in the Updates tab with the blocked package, `installed → blocked`
  version and the pinning packages/ranges. Rows that still have a safe version
  show a lock icon with the same detail.
- `npm run docs` was not run: it installs Playwright/Chromium and rewrites
  `package.json`, and the conflict section only renders when such a conflict
  exists.
- Follow-ups (out of scope): the NU1605 auto-fix in
  `restoreWithConflictResolutionAsync` still writes CPM versions with the
  default `scope: "first"`; a multi-TFM props file can therefore get the wrong
  group rewritten. Consider resolving the matching `CpmResolution` first.
