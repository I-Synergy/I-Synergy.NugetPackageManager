# Plan: Codebase Improvements

## Context
Following a broad codebase audit, several categories of improvements were identified:
security vulnerabilities, dead code, outdated dependencies, missing CI checks, and
TypeScript strictness gaps. Goal: fix all of them while keeping build, lint, and tests
fully green.

---

## Step 1 — Fix security vulnerabilities (npm overrides)

**Files:** `package.json`, `package-lock.json`

Two high-severity vulnerabilities arrive via `mocha ← @vscode/test-cli`:
- `serialize-javascript ≤7.0.2` — RCE (GHSA-5c6j-r48x-rmvq)
- `diff ≥6.0.0 <8.0.3` — DoS (GHSA-73rr-hh4g-fpgx)

Add to the `overrides` block:
```json
"serialize-javascript": "7.0.3",
"diff": "8.0.3"
```

Run `npm install` then `npm audit --audit-level=high` to verify 0 high/critical remain.

---

## Step 2 — Remove dead code: `ExecuteTask()`

**Files:**
- `src/host/utilities/task-executor.ts` — delete the `ExecuteTask()` method (lines ~89-127)
- `src/host/utilities/task-executor.test.ts` — delete the test suite for `ExecuteTask`

Verify by running `npm run test-compile` and `npm test`.

---

## Step 3 — Update outdated dependencies

Update in `package.json`:

| Package | From | To |
|---------|------|----|
| `@opentelemetry/api` | `^1.8.0` | `^1.9.0` |
| `@opentelemetry/exporter-trace-otlp-http` | `^0.51.1` | `^0.213.0` |
| `jsdom` | `^28.1.0` | `^29.0.0` |
| `@types/jsdom` | `^28.0.0` | `^29.0.0` |

**Note:** `@types/node` stays at `^20.x` (matches Node 20 LTS). `eslint` stays at `^9.x` (v10 is a major bump).

After updating the OTel exporter, check `src/common/logger.ts` for any API changes:
- `SEMRESATTRS_*` constants are deprecated in semantic-conventions ≥1.27 in favour of `ATTR_*`. Update imports if needed.
- `BasicTracerProvider`, `OTLPTraceExporter`, `Resource`, `SimpleSpanProcessor` APIs are stable — verify they still compile.

Run `npm install` then `npm run esbuild` to verify build succeeds.

---

## Step 4 — Add CI quality gates

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`

Add two steps **after lint, before tests** in both the `build` job (ci.yml) and `release` job (release.yml):

```yaml
- name: Type check
  run: npx tsc --noEmit

- name: Security audit
  run: npm audit --audit-level=high
```

This ensures type errors are caught even though esbuild skips type checking, and
vulnerabilities are gated in CI.

---

## Step 5 — Enable stricter TypeScript options

**File:** `tsconfig.json`

Add to `compilerOptions`:
```json
"noUncheckedIndexedAccess": true,
"exactOptionalPropertyTypes": true,
"noImplicitOverride": true
```

Then run `npx tsc --noEmit` and fix all resulting errors. Expected fixes:
- Array index accesses may need `?? fallback` or explicit bounds checks
- Optional property assignments may need `undefined` removed from union or checked differently
- Any `override` keywords needed on subclass methods

---

## Step 6 — Add tests for `host-api.ts`

**Files:**
- `src/host/host-api.test.ts` (new file)

Cover the key RPC methods using the same Sinon sandbox pattern from existing tests
(`api.test.ts`, `task-executor.test.ts`):

Methods to test:
- `getProjects` — stubs `vscode.workspace.findFiles` + `ProjectParser.Parse`
- `getPackages` — stubs `NugetApiFactory.GetOrCreate` + `api.GetPackagesAsync`
- `getConfiguration` — stubs `vscode.workspace.getConfiguration`
- `getOperationProgress` — stubs `TaskExecutor.GetProgress`
- `showConfirmation` — stubs `vscode.window.showInformationMessage`
- Error paths — stub throws, assert `fail()` result

Mock pattern:
```typescript
import * as sinon from 'sinon';
import { createHostAPI } from '../../host/host-api';

suite('HostAPI Tests', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });
  // ...
});
```

---

## Step 7 — Credentials cache: add TTL

**File:** `src/host/utilities/credentials-cache.ts`

Add a 5-minute TTL to match `PasswordScriptExecutor`'s cache TTL:
- Store entry as `{ username?, password?, timestamp: number }`
- In `get()`: return `undefined` if `Date.now() - timestamp > TTL`
- Add `clearExpired()` helper

---

## Verification

After all steps, run in order:
```bash
npm run lint          # 0 warnings
npx tsc --noEmit      # 0 errors
npm run esbuild       # build complete
npm run test-compile  # 0 errors
npm audit --audit-level=high  # 0 high/critical
```

CI should pass green on push.
