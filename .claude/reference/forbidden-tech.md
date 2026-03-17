# Forbidden Technologies

These packages or patterns must NOT be used in this project.

## Forbidden Packages / APIs

| ❌ DO NOT USE | ✅ USE INSTEAD | Why |
|---------------|---------------|-----|
| `import { randomBytes } from "crypto"` | `globalThis.crypto.randomUUID()` | `crypto` is Node.js-only; `src/common/` runs in both host and browser |
| `import { randomUUID } from "crypto"` | `globalThis.crypto.randomUUID()` | Same reason |
| `vscode.Task` for install/update | `child_process.spawn` via `TaskExecutor` | `vscode.Task` doesn't support real-time stdout streaming for progress |
| Manual polling loops with `sleep` | `setInterval` + clear on `Active=false` | Busy-wait loops burn CPU; the established pattern is `getOperationProgress` polled every 300ms |
| AutoMapper / Mapster | N/A — this is TypeScript | Not applicable |
| MediatR | N/A — this is TypeScript | Not applicable |
| Repository pattern | N/A — this is TypeScript | Not applicable |

## Anti-Patterns

| ❌ Don't Do | ✅ Do Instead |
|------------|--------------|
| Throw from RPC handler | Return `fail(message)` |
| Pass project path to dotnet without workspace validation | Validate with `vscode.workspace.getWorkspaceFolder()` |
| Add anonymous event listeners | Store as class field arrow functions for proper cleanup |
| Import Node.js builtins in `src/common/` | Use platform-neutral APIs (`globalThis`, etc.) |
| Use `import type` violations | Keep `import type` for type-only imports to avoid runtime bundle issues |
| Call `eslint` v10+ APIs | Stay on ESLint 9.x (v10 has breaking config changes not yet migrated) |
