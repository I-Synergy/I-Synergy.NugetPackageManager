# Project Architecture

## Overview

**NuGet Package Manager** is a VS Code extension with a **dual-process architecture** — an Extension Host (Node.js) and a Webview (browser), communicating over a typed RPC layer via `postMessage`.

## Dual-Process Model

```
VSCode Extension Host (Node.js)            VSCode Webview (Browser)
  src/host/extension.ts                      src/web/main.ts
  src/host/host-api.ts                       src/web/registrations.ts
  RpcHost (postMessage)  <── typed RPC ──>   RpcClient (ES Proxy)
  TaskExecutor (child_process.spawn)         Lit components
  NuGet API (axios)                          Split.js layout
  dotnet CLI                                 VS Code CSS variables
```

### Why Dual-Process?

VS Code extensions run host-side code in Node.js and UI in a sandboxed browser context (webview). They cannot share memory — all communication must be via message passing.

## Typed RPC Layer

All host ↔ webview communication uses a typed RPC contract:

- **Contract**: `HostAPI` interface in `src/common/rpc/types.ts`
- **Wire format**: `{ type: 'rpc-request', id, method, params }` / `{ type: 'rpc-response', id, result }`
- **Result type**: `{ ok: true, value: T } | { ok: false, error: string }` — every method returns `Result<T>`
- **RpcHost**: Dispatches incoming requests to `HostAPI` implementations (`src/common/rpc/rpc-host.ts`)
- **RpcClient**: ES Proxy that intercepts property access and turns it into RPC calls (`src/common/rpc/rpc-client.ts`)
- **Timeout**: 120 seconds (`RPC_TIMEOUT_MS`) — intentionally long to handle large solution restores

### Adding a New RPC Method

1. Add request/response types to `src/common/rpc/types.ts`
2. Add method signature to `HostAPI` interface in `types.ts`
3. Implement in `src/host/host-api.ts` (return `Result<T>`)
4. Call from webview: `await hostApi.methodName(request)`

## src/common/ — Isomorphic Module Zone

`src/common/` is bundled into **both** bundles (host + web). These files must:
- Use `globalThis.crypto` instead of `import ... from "crypto"`
- Not import `vscode` or any Node.js built-in
- Not import any file from `src/host/` or `src/web/`

## Real-time Progress

Long-running operations (install/update/uninstall) stream progress to the UI:

1. Webview generates `operationId = \`${type}-${packageId}-${Date.now()}\``
2. Passes `operationId` to `updateProject` RPC call
3. `TaskExecutor.ExecuteCommand` spawns dotnet, parses stdout stages, stores in `Map<operationId, OperationProgress>`
4. Webview polls `getOperationProgress` every 300ms
5. `project-row` shows animated progress bar; stops polling when `Active=false` or on `disconnectedCallback`

## Web Components (Lit)

UI uses LitElement with VS Code CSS variable theming:

- `@customElement("tag-name")` registers the element
- `@state()` for internal reactive state
- `@property()` for reflected attributes
- CSS-in-JS via `css` tagged templates using `--vscode-*` variables
- Module-level singletons in `registrations.ts`: `hostApi`, `router`, `configuration`

### View Routing

Single-page navigation managed by `RouterType` in `src/web/router.ts`. The root `nuget-packages-manager` element renders different views based on `router.CurrentRoute`.

### Tab Auto-Refresh

Updates, Consolidate, and Vulnerabilities tabs auto-refresh on tab switch. Guard: `if (tab === this.activeTab) return` prevents redundant reloads.

## Data Flow

```
User action (click install)
  → Lit component event handler
  → hostApi.updateProject(req)           [RPC call over postMessage]
  → RpcHost dispatches to host-api.ts
  → TaskExecutor.ExecuteCommand(dotnet)  [child_process.spawn]
  → dotnet stdout parsed for progress stages
  → Component polls getOperationProgress every 300ms
  → Progress bar updates in UI
  → Active=false → polling stops
```

## Security Architecture

| Concern | Mitigation |
|---------|-----------|
| Path traversal | Validate paths against `vscode.workspace.getWorkspaceFolder()` before dotnet |
| URL injection | Validate with `new URL()` before passing to dotnet CLI |
| Script execution | Explicit allowlist: `.ps1`, `.bat`, `.cmd`, `.sh` only |
| Nonce generation | `globalThis.crypto.randomUUID()` — works in both host and browser |
| Sort/filter injection | Validate user input against explicit allowlist before use |

## Build Architecture

Two separate esbuild bundles:

| Bundle | Entry | Output | Platform | Format |
|--------|-------|--------|----------|--------|
| Host | `src/host/extension.ts` | `dist/extension.js` | Node.js | CommonJS |
| Web | `src/web/main.ts` | `dist/web.js` | Browser | ESM |

Build is triggered by `npm run esbuild` (or automatically via PostToolUse hook on Edit/Write).
