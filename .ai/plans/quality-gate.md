# Plan: Quality Gate

**Status:** IMPLEMENTED — committed locally, not pushed
**Date:** 2026-10-30
**Scope:** add a CI + local quality gate (lint with SonarJS, type check, tests with
coverage, dependency audit, SonarCloud scan) and fix the findings it reports before
the first commit.

## 1. Context

NuGet Package Manager already ran lint, `tsc`, tests and `npm audit` in `ci.yml`, but
there was no single pre-commit gate, no SonarJS static analysis and no SonarCloud
configuration, unlike AIWorkspaceManager and I-Synergy.Framework. This change adds
that gate and clears the correctness/security findings it surfaced.

## 2. Workstreams

1. **Local gate** — `tools/quality-gate.mjs` + `npm run quality` / `quality:coverage`.
2. **SonarJS** — `eslint-plugin-sonarjs` in the flat config. Correctness and security
   findings are errors; known maintainability debt (complexity, nesting, regex cost)
   is a warning so the gate can be introduced without one unreviewable refactor.
3. **Coverage** — `@vscode/test-cli` coverage (`npm run test:coverage`) writes
   `coverage/lcov.info`; exclude tests and fixtures.
4. **SonarCloud** — `sonar-project.properties` + the `Quality Gate` workflow, with the
   scan skipped when `SONAR_TOKEN` is absent.
5. **Fixes** — dead store, unused collection/variable, redundant null comparison,
   duplicate character class, deprecated OpenTelemetry constants, writable static
   styles, RPC message-origin check, locale-independent cache-key sorting, intentional
   test fixture rules.
6. **Docs/badges** — README badges (CI, quality gate, SonarCloud, Marketplace) and a
   README section documenting the local gate.

## 3. Verification

- `npm run quality` — build, lint, type check, 434 tests, audit: PASS
- `npm run test:coverage` — 434 tests, `coverage/lcov.info` produced
- `npx tsc --noEmit` — clean
- Lint — 0 errors, 72 pre-existing maintainability warnings
