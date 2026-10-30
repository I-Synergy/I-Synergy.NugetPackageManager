# Plan: SonarCloud Remediation and Automatic Versioning

**Status:** IMPLEMENTED — committed locally, not pushed
**Date:** 2026-10-30
**Scope:** clear the SonarQube Cloud findings for product code, scope the analysis
to product paths, and replace manual version bumps with the AI-repository release
scheme.

## 1. Context

SonarQube Cloud reported 1504 issues (1336 code smells, 144 bugs, 24 vulnerabilities)
on `I-Synergy_NugetPackageManager`. 1204 of them were in `.ai/skills/**` template
content and 31 in `docs/**` mockups, which are not product code. The extension itself
had 214 findings, `tools/` 42, `.github/` 10 and root scripts 3.

## 2. Workstreams

1. **Analysis scope** — add `.sonarcloud.properties` (automatic analysis reads this,
   not `sonar-project.properties`) excluding `.ai/**`, `docs/**`, generated output and
   fixtures; keep `src/**`, `tools/**`, `.github/**` and root scripts in scope.
2. **CI security** — `npm ci --ignore-scripts`, no `npx`, pin the release action,
   replace the Sonar scanner step (automatic analysis needs no token).
3. **Product findings** — fix all 269 scoped findings, including 13 vulnerabilities
   and 36 cognitive-complexity hotspots, by extracting helpers rather than
   suppressing. The ESLint + SonarJS run must end with zero errors and zero warnings.
4. **Duplication** — deduplicate the three `fixturesRoot` test helpers and the
   `src/host/host-api.ts` blocks exposed by the refactor.
5. **Automatic versioning** — replace `tools/release.mjs` and the manual release
   workflow with a date-based release workflow (`YYYY.1MMdd.1HHmm`, tag without `v`,
   generated release notes), matching I-Synergy/AI.

## 3. Verification

- `npm run quality` — PASS (build, lint, type check, 434 tests, audit)
- `npx eslint src` — 0 errors, 0 warnings
- `npm run test:coverage` — lcov produced for SonarCloud
- `.ai/tests/run-all-tests.sh` — 11/11 suites
