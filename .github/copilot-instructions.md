# GitHub Copilot Instructions

## Project Context

**NuGet Package Manager** is a Visual Studio Code extension (TypeScript/Node.js) for browsing, installing, updating, and auditing NuGet packages across .NET projects. It is NOT a .NET/C# project.

See `CLAUDE.md` for the full development guide.

## Architecture

The extension has two separate runtime contexts:

```
VS Code Extension Host (Node.js)         Webview (Browser / Lit components)
  src/host/extension.ts                    src/web/main.ts
  src/host/host-api.ts  <-- RPC -->        src/web/components/
  src/common/rpc/rpc-host.ts               src/common/rpc/rpc-client.ts
```

All host ↔ webview communication goes through a typed RPC layer defined in `src/common/rpc/types.ts`. Every RPC method returns `Result<T>` — a discriminated union `{ ok: true, value: T } | { ok: false, error: string }`.

## Key Rules

### TypeScript
- `strict: true` — no `any` unless unavoidable
- Prefix unused variables with `_`
- Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`

### RPC Methods (host-api.ts)
- Always return `Result<T>` using `ok(value)` / `fail(message)` helpers
- Validate all inputs at the RPC boundary (workspace paths, URLs, sort options)
- Never pass user-controlled strings directly to `child_process.spawn` args without validation

### Web Components (Lit)
- Use `@state()` for reactive internal state, `@property()` for external inputs
- Store event listeners as class fields; always clean up in `disconnectedCallback`
- Use `await element.updateComplete` in tests, not manual DOM ticks
- No raw `innerHTML` — use Lit `html` template literals (XSS-safe)

### Security
- Nonces: `globalThis.crypto.randomUUID().replace(/-/g, "")` — works in Node.js 19+ and browser
- Project paths must be validated inside a workspace folder before passing to dotnet
- Source URLs must be validated with `new URL()` before passing to dotnet
- Password script extensions are restricted to `.ps1`, `.bat`, `.cmd`, `.sh`

### Progress Tracking
- `child_process.spawn` is used (not `vscode.Task`) so stdout can be parsed for progress stages
- `TaskExecutor.ExecuteCommand` stores progress in a `Map<string, OperationProgress>` keyed by `operationId`
- Webview polls `getOperationProgress` every 300ms; always stop polling in `disconnectedCallback`

## Build Commands

```bash
npm run esbuild    # compile host + web bundles
npm run lint       # ESLint 9
npm test           # VSCode Test CLI + Mocha
npm run package    # produce .vsix
```

## File Conventions

| Path pattern | Purpose |
|---|---|
| `src/host/*.ts` | Extension host (Node.js) — VS Code API, dotnet CLI |
| `src/host/utilities/*.ts` | Host utilities (nuget config, task executor, decorators) |
| `src/web/components/*.ts` | Lit web components (browser) |
| `src/common/rpc/` | Shared RPC types, host, client |
| `src/common/*.ts` | Shared types/utilities (must be isomorphic — no Node.js-only imports) |
