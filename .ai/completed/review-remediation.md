# Review Remediation

Status: DONE (with residual follow-ups)
Started: 2026-10-24
Completed: 2026-10-24
Plan: `.ai/plans/whole-application-review-remediation.md`
Review: `.ai/analysis/whole-application-review-2026-10-24.md`

## Milestones

### M0 — Clean base + regression tests
- [x] Commit the `.ai/` migration as a dedicated commit
- [x] Add regression tests for Blockers and write paths

### M1 — Blockers
- [x] B1 workspace script/trust boundary
- [x] B2 unconditional CPM scope
- [x] B3 workspace path containment
- [x] B4 credential env expansion

### M2 — CPM correctness
- [x] M1 consolidate result + row removal
- [x] M3 per-project TFM context
- [x] M4 element-level conditions
- [x] m11 repeated-condition ordering

### M3 — Security hardening
- [x] M5 package/version validation + atomic writes
- [x] M6 vulnerability keys + partial cache
- [x] M7 latest-version sorting
- [x] M8 credential origin scoping
- [x] m5–m10, m13

### M4 — Reliability
- [x] M2/M15 RPC cancellation + process timeout
- [x] m2 decorator timer
- [x] m3 dead settings
- [x] m4 dependency declarations
- [x] m12/m14 tests and visible failures

### M5 — UI/UX
- [x] M13 lazy tabs
- [x] M14 visible update failures
- [x] M16 sort
- [x] m16 accessibility (focus + Escape; Tab trap still open)
- [x] m19 VS Code tasks/launch

### M6 — Packaging/release/docs
- [x] M9 `.vscodeignore`
- [x] M10 release gating
- [x] M12 pretest + README
- [x] m17 docs drift
- [x] m20 dead type

### M7 — Coverage and final validation
- [x] Host/RPC/UI tests (RPC transport, consolidate, updates scope, vulnerability matching, path/identifier/version, CPM writes)
- [x] Full verification + framework e2e + packaging check

## Verification
- `npm run esbuild` — clean
- `npm run lint` — clean
- `npm test` — 313 passing (includes pretest compile)
- Framework e2e: TFMs net10.0/net11.0, 69 unconditional + 2×31 conditional, scoped net11 write
- `vsce ls` — 18 files, no `.ai/`, `.reasonix/`, `AGENTS.md`, or tests
- `.ai/tests/run-all-tests.sh` — re-run after documentation changes

## Residual follow-ups
- `m15`: a few tests still use fixed `setTimeout` waits (project-row, search-bar, password executor).
- `m14`: several `api-factory` tests still assert on log messages rather than the returned instance.
- `m16`: license dialog traps Escape/focus but does not implement a full Tab cycle; dropdown keyboard support already existed.
- Coverage: Updates/Vulnerabilities/Settings/ProjectTree web components and host `restoreProjectsAsync`/`consolidatePackagesAsync` still lack dedicated tests.
- CI workflow changes were reviewed statically; the release gate has not been executed on GitHub.
