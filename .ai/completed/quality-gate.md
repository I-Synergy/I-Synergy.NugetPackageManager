# Quality Gate

Status: DONE
Started: 2026-10-30
Completed: 2026-10-30

## Steps
- [x] Add `eslint-plugin-sonarjs` to the flat config with an error/warning policy
- [x] Add `tools/quality-gate.mjs` and the `quality` / `quality:coverage` scripts
- [x] Add test coverage (`npm run test:coverage` -> `coverage/lcov.info`)
- [x] Add `sonar-project.properties`
- [x] Add `.github/workflows/quality-gate.yml` with the SonarCloud scan
- [x] Fix the SonarJS correctness/security findings
- [x] Add README badges and document the local gate
- [x] Run `npm run quality` (build, lint, type check, 434 tests, audit) — PASS
- [x] Run `npm run test:coverage` — 434 tests, lcov produced
- [x] Commit after review (local only; not pushed)

## Notes

- The SonarCloud scan is conditional on the `SONAR_TOKEN` repository secret. The
  `I-Synergy_NugetPackageManager` project is connected in the `i-synergy` organisation;
  the badges compute after the first scan.
- 72 maintainability warnings remain (cognitive complexity, nested conditionals,
  nested template literals, two duplicate test helpers, five super-linear regexes).
  They are reported by the gate, not fatal, and are the next ratchet target.
