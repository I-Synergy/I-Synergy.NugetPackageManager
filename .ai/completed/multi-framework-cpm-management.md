# Multi-Framework CPM Version Management
Status: DONE
Started: 2026-10-24
Completed: 2026-10-24
Plan: `.ai/plans/multi-framework-cpm-management.md`

## Decisions
- Scope: full plan (phases 0–7)
- Version policy: aligned latest first; overall latest behind explicit action

## Steps
- [x] Phase 0 — fixtures + characterization tests
- [x] Phase 1 — condition model and evaluator (`cpm-condition.ts`)
- [x] Phase 2 — TFM discovery (`project-framework-resolver.ts`)
- [x] Phase 3 — host resolution matrix
- [x] Phase 4 — write path (`UpdateCpmVersionsAsync`)
- [x] Phase 5 — UI (per-TFM rows, TFM filter, Update all TFMs, overall-latest action)
- [x] Phase 6 — general optimizations (source mapping, excludes, lookup cache, `.slnx`)
- [x] Phase 7 — validation, docs, screenshots

## Verification
- `tsc -p tsconfig.test.json` — clean
- ESLint (`eslint src`) — clean
- Unit/integration suite — 277 passing
- End-to-end probe against `D:\Projects\I-Synergy\I-Synergy.Framework`:
  - TFMs: `net10.0;net11.0` via MSBuild
  - 69 unconditional + 2 × 31 conditional groups
  - Logging resolves 10.0.13 / 11.0.0-rc.2.26504.105 per TFM
  - net11-only update leaves the net10 line at 10.0.13
- Screenshots: `docs/images/screenshot-installed-frameworks.png`, `screenshot-updates-frameworks.png`, `screenshot-updates-net9.png`, `screenshot-installed-net9.png`

## Notes
- Shell has no `node`/`npm`; verification used `ELECTRON_RUN_AS_NODE=1 .vscode-test/.../Code.exe`.
- Fixtures live in `src/host/utilities/__fixtures__/cpm` and `.../projects`.
