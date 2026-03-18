# NuGet Package Manager — Session Context

**Last Updated:** 2026-03-17
**Project Version:** 1.0.0
**Branch:** main

---

## Project Overview

**Extension ID:** `I-Synergy.NugetPackageManager.I-Synergy.NugetPackageManager`
**Purpose:** VS Code extension for browsing, installing, updating, and auditing NuGet packages across .NET projects without leaving the editor.
**Stack:** TypeScript, Node.js (host), Lit (webview), dotnet CLI, typed RPC over postMessage
**Phase:** Active development — post-fork hardening

---

## Recent Work (this session and last)

### Completed: Real-time Progress Bar
- Migrated `executeAddPackage` / `executeRemovePackage` from `vscode.Task` → `child_process.spawn`
- `TaskExecutor.ExecuteCommand` parses dotnet stdout for stage keywords, stores in `Map<operationId, OperationProgress>`
- Added `getOperationProgress` RPC method; webview polls every 300ms
- `project-row` shows animated progress bar (stage label + fill bar) during operations
- Polling stopped in `disconnectedCallback` and when `Active=false`

### Completed: Tab Auto-refresh
- Updates, Consolidate, Vulnerabilities tabs auto-refresh when switched to
- `setTab()` guards with `if (tab === this.activeTab) return` to avoid redundant reloads
- Removed per-tab refresh buttons (they were redundant)

### Completed: Security Hardening (commit 537a330)
- `nonce.ts`: `globalThis.crypto.randomUUID()` — no Node.js import, works in browser too
- `host-api.ts`: workspace path validation + URL validation in `updateProject`
- `password-script-executor.ts`: explicit allowlist for `.ps1/.bat/.cmd/.sh`, reject others
- `task-executor.ts`: proper `await mutex.acquire()`, 120s timeout, `clearTimeout` on success
- `project-row.ts`: stop polling on `Active=false`, cleanup in `disconnectedCallback`
- `search-bar.ts`: sort option whitelist validation
- `main.ts`: stored event listeners + `disconnectedCallback` cleanup

### Completed: Documentation & Assets
- Official NuGet logo as extension icon (`docs/images/icon.png`, `docs/raw/icon.svg`)
- README updated with Real-time Progress feature, auto-refresh notes, retry button
- CHANGELOG.md updated with full Unreleased section

### Completed: Dependency Updates
- Updated 16 packages (skipped eslint 9→10, opentelemetry version pin)

---

## Established Patterns

### RPC Pattern
All host↔webview calls use typed RPC (`src/common/rpc/types.ts`). Every method returns `Result<T>`. Add new methods by:
1. Adding request/response types to `types.ts`
2. Adding the method signature to `HostAPI` interface in `types.ts`
3. Implementing in `host-api.ts`
4. Calling via `hostApi.methodName(request)` from webview

### Error Handling
RPC methods use `ok(value)` / `fail(message)` helpers. Never throw — always return `fail()`.

### Progress Operations
For long-running operations:
1. Generate `operationId = \`${type}-${packageId}-${Date.now()}\``
2. Pass to `TaskExecutor.ExecuteCommand`
3. Start polling `getOperationProgress` every 300ms
4. Stop polling when `Active=false` or component disconnected

---

## Known Issues / Decisions

### RPC Timeout
Increased from 30s → 120s (`RPC_TIMEOUT_MS` in `types.ts`) to handle large solution restores. This is intentional.

### OpenTelemetry
Used for anonymous usage telemetry (operation counts, error rates). Connects to an OTLP endpoint configured in `host-api.ts`. No PII is sent. The endpoint is hardcoded to the project's own collector.

### ESLint Version
Staying on ESLint 9.x — ESLint 10 has breaking config changes that aren't worth migrating now.

### src/common/ Isomorphism
Files in `src/common/` are bundled into BOTH the host (Node.js) and web (browser) bundles. They must not import Node.js-only modules. Use `globalThis.crypto` instead of `import { randomBytes } from "crypto"`.

---

## Open Plan

There is a plan at `.claude/plans/partitioned-orbiting-walrus.md` to migrate `.claude/` content to `.ai/` (vendor-neutral folder). This has NOT been executed yet. The user has not requested it.

---

## Next Session Checklist

1. **If releasing**: Update `package.json` version, run `npm run package`, verify `.vsix`
2. **If adding RPC method**: types.ts → host-api.ts → webview call
3. **If editing `src/common/`**: Ensure no Node.js-only imports (test with `npm run esbuild`)
4. **Before any commit**: `npm run esbuild` + `npm run lint` (0 errors required)
