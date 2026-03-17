# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Identity

This is **NuGet Package Manager** — a VS Code extension for browsing, installing, updating, and auditing NuGet packages across .NET projects. It is a TypeScript/Node.js project, not a .NET/C# project.

## Build & Development Commands

```bash
npm run esbuild          # Build (dev) - compiles host + web bundles
npm run lint             # Check code style (ESLint 9 flat config)
npm run lint:fix         # Auto-fix linting issues
npm test                 # Run tests (VSCode Test CLI + Mocha)
npm run test-compile     # Compile tests only (tsconfig.test.json)
npm run package          # Package extension (.vsix) into releases/
```

Build produces two separate bundles via `esbuild.js`:
- **Host**: `src/host/extension.ts` → `dist/extension.js` (Node.js, CommonJS)
- **Web**: `src/web/main.ts` → `dist/web.js` (Browser, ESM)

## Environment

- **Platform**: Windows 11 (paths use backslashes internally; use forward slashes in shell commands)
- **Shell**: bash via Git Bash / MSYS2 (use Unix syntax: `/dev/null`, forward slashes)
- **Node.js**: v19+ required (for `globalThis.crypto.randomUUID()`)
- **dotnet CLI**: must be on PATH for install/update/restore operations

## Architecture

### Dual-Process Model

The extension runs in two separate contexts communicating via `postMessage`:

```
VSCode Extension Host (Node.js)          VSCode Webview (Browser)
  extension.ts                              main.ts
  RpcHost (postMessage)  <-- RPC -->       RpcClient (acquireVsCodeApi)
  host-api.ts                               components/*
```

### Typed RPC Layer (Core IPC)

All host-web communication uses a **typed RPC layer** with `Result<T>`:

- **HostAPI interface** in `src/common/rpc/types.ts` — defines all methods with typed request/response
- **Result<T>**: Discriminated union `{ ok: true, value: T } | { ok: false, error: string }`
- **Wire protocol**: `{ type: 'rpc-request', id, method, params }` / `{ type: 'rpc-response', id, result }`
- **RpcHost** (`src/common/rpc/rpc-host.ts`): Host-side dispatcher mapping method names to HostAPI
- **RpcClient** (`src/common/rpc/rpc-client.ts`): Client-side ES Proxy, 120s timeout, Promise-based
- **Host implementation** in `src/host/host-api.ts`: All handlers as functions returning `Result<T>`

### Real-time Progress

Install/update operations stream dotnet stdout via `child_process.spawn`:

- `TaskExecutor.ExecuteCommand` in `src/host/utilities/task-executor.ts` — spawns dotnet, parses output lines into progress stages, stores in `Map<string, OperationProgress>`
- `getOperationProgress` RPC method — webview polls every 300ms during an active operation
- `project-row` component manages poll lifecycle: start on request, stop on `Active=false` or `disconnectedCallback`

### Web Components (Lit)

UI uses **Lit** (LitElement) with native HTML elements styled via VS Code CSS variables:

- `@customElement("tag-name")` decorator for components
- `@state()` for internal reactive state, `@property()` for external attributes
- Template syntax: `html` literals, `.prop` (property binding), `?attr` (boolean attr), `@event`
- Module-level singletons in `src/web/registrations.ts`: `hostApi`, `router`, `configuration`

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `packages-view` | `src/web/components/packages-view.ts` | Main 3-pane layout (project tree / packages / details) with Split.js |
| `project-tree` | `src/web/components/project-tree.ts` | Checkbox tree for project selection |
| `updates-view` | `src/web/components/updates-view.ts` | Outdated packages tab — auto-refreshes on tab switch |
| `consolidate-view` | `src/web/components/consolidate-view.ts` | Version inconsistency finder — auto-refreshes on tab switch |
| `vulnerabilities-view` | `src/web/components/vulnerabilities-view.ts` | CVE scanning — auto-refreshes on tab switch |
| `search-bar` | `src/web/components/search-bar.ts` | Search + source + prerelease filter |
| `package-row` | `src/web/components/package-row.ts` | Package list item |
| `project-row` | `src/web/components/project-row.ts` | Per-project install/update/uninstall UI with progress bar |

### Path Alias

`@/*` resolves to `src/*` (configured in `tsconfig.json`, resolved by `esbuild`).

## Testing

Tests use **VSCode Test CLI** with Mocha (bundled in `@vscode/test-cli`) + Sinon + Node.js assert:

- Test files: `src/**/*.test.ts`
- Mocking: Sinon sandboxes for VSCode API, Axios, file system
- Test config: `tsconfig.test.json` (CommonJS override for Node.js execution)
- Pattern: Arrange with stubs → Act via component method → Assert with `assert.strictEqual`
- Web component tests: Mock `hostApi` via `Object.defineProperty(registrations, 'hostApi', { value: mock })`
- Lit updates: Use `await element.updateComplete` instead of manual DOM tick

Run a single test file by modifying `.vscode-test.mjs` config or using the test explorer.

## Code Conventions

- **Strict TypeScript**: `strict: true`, avoid `any` (warn-level in ESLint)
- **Unused vars**: Prefix with `_` to suppress warnings
- **Error responses**: RPC methods return `Result<T>` — use `ok(value)` / `fail(error)` helpers
- **Styling**: CSS-in-JS via Lit `css` tagged template literals, using VS Code CSS variables
- **Commit messages**: English, conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, etc.)
- **No `.Update()` on EF entities** — this project doesn't use EF Core; ignore C# rules

## Security Rules

These apply to this project specifically:

| Area | Rule |
|------|------|
| Nonce generation | Use `globalThis.crypto.randomUUID()` — works in both Node.js 19+ and browser |
| Path validation | Always validate project paths are inside a workspace folder before passing to dotnet |
| URL validation | Validate source URLs with `new URL()` before passing to dotnet CLI |
| Script execution | Password scripts restricted to `.ps1`, `.bat`, `.cmd`, `.sh` — reject unknown extensions |
| Sort/filter input | Validate against explicit allowlist before use |
| Event listeners | Store as class fields for proper cleanup; always remove in `disconnectedCallback` |

## Technology Stack

- **UI Framework**: Lit 3.x (LitElement)
- **HTTP**: axios (NuGet API, proxy/auth support)
- **XML Parsing**: @xmldom/xmldom + xpath (.csproj/.sln files)
- **Layout**: Split.js (resizable panes)
- **Concurrency**: async-mutex (task serialization)
- **Telemetry**: OpenTelemetry (OTLP exporter, opt-in, no PII)
- **Build**: esbuild 0.25+
- **Lint**: ESLint 9 + typescript-eslint + prettier compat

## Task Execution Protocol

**On every non-trivial task (3+ steps or multi-file):**

1. Enter plan mode (`EnterPlanMode`), present the plan, wait for approval
2. Create a progress file at `.claude/progress/{task-slug}.md`
3. Update progress file after each step (Edit `- [ ]` → `- [x]`)
4. On completion: mark DONE and move to `.claude/completed/`

**Do NOT use built-in `TaskCreate`/`TaskUpdate`/`TaskList` tools** — use local `.claude/progress/` markdown files instead.

## Session Management

1. Read `.claude/session-context.md` at session start
2. Update it before ending with current state and next steps
3. Plans are stored in `.claude/plans/` (configured via `plansDirectory` in `.claude/settings.json`)
