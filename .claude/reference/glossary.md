# Terminology Glossary

## Core Concepts

| Term | Definition |
|------|------------|
| **Extension Host** | Node.js process where the VS Code extension runs. Has access to `vscode` API, file system, and can spawn child processes. |
| **Webview** | Sandboxed browser context rendering the UI. Cannot access file system or `vscode` API directly. |
| **RPC** | Remote Procedure Call — typed message-passing protocol between host and webview over `postMessage`. |
| **HostAPI** | TypeScript interface (`src/common/rpc/types.ts`) defining all methods callable from webview to host. |
| **Result\<T\>** | Discriminated union: `{ ok: true, value: T } \| { ok: false, error: string }`. All RPC methods return this. |
| **RpcHost** | Host-side dispatcher that receives `rpc-request` messages and routes to `HostAPI` implementations. |
| **RpcClient** | Browser-side ES Proxy that transparently turns `hostApi.method(params)` into `postMessage` calls. |
| **TaskExecutor** | Utility that spawns dotnet CLI via `child_process.spawn`, parses stdout for progress, and stores stage info. |
| **OperationProgress** | `{ stage: string, percent: number }` — current state of a running dotnet operation. |
| **operationId** | Unique key for a running operation: `` `${type}-${packageId}-${Date.now()}` ``. Used to look up progress. |
| **CPM** | Central Package Management — `Directory.Packages.props` pattern for NuGet version pinning. |
| **CacheControl** | `{ ForceReload?: boolean }` — forces bypass of in-memory cache for NuGet API calls. |
| **isomorphic** | Code that runs unchanged in both Node.js (host) and browser (webview). All `src/common/` files must be isomorphic. |

## Component Terms

| Term | Definition |
|------|------------|
| **`@state()`** | Lit decorator marking a field as internal reactive state — triggers re-render on change. |
| **`@property()`** | Lit decorator marking a field as an observed attribute — can be set from outside the component. |
| **`disconnectedCallback()`** | Lit lifecycle hook called when component is removed from DOM — use for cleanup (remove event listeners, stop polling). |
| **`updateComplete`** | Lit Promise that resolves after the next render cycle — use in tests instead of `setTimeout`. |
| **singleton** | Module-level export in `registrations.ts` (`hostApi`, `router`, `configuration`) shared across all components. |

## NuGet Terms

| Term | Definition |
|------|------------|
| **Source** | A NuGet feed URL (e.g., `https://api.nuget.org/v3/index.json` or a private feed). |
| **Prerelease** | Package version with a pre-release suffix (e.g., `-beta`, `-rc1`). |
| **Outdated** | A package where a newer stable (or pre-release if opted in) version exists. |
| **Inconsistent** | Same package installed at different versions across projects in the solution. |
| **Vulnerable** | Package with a known CVE per `dotnet list package --vulnerable`. |
