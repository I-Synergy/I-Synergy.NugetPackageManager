# Technology Stack

## Runtime & Language

- **Runtime**: Node.js v19+ (host), Browser (webview)
- **Language**: TypeScript 5.x (`strict: true`)
- **Node.js requirement**: v19+ for `globalThis.crypto.randomUUID()`

## Core Dependencies

| Category | Package | Version | Notes |
|----------|---------|---------|-------|
| **UI Framework** | `lit` | ^3.3.2 | LitElement web components |
| **HTTP Client** | `axios` | ^1.7.4 | NuGet API calls, proxy/auth support |
| **XML Parsing** | `@xmldom/xmldom` | ^0.8.10 | Parse `.csproj` / `.sln` files |
| **XML Queries** | `xpath` | ^0.0.34 | XPath queries over parsed XML |
| **Layout** | `split.js` | ^1.6.5 | Resizable panes in main 3-panel view |
| **Concurrency** | `async-mutex` | ^0.5.0 | Serialize dotnet task execution |
| **Telemetry** | `@opentelemetry/*` | various | Opt-in anonymous usage telemetry, OTLP |
| **Hashing** | `object-hash` | latest | Change detection for project lists |
| **Deep utils** | `lodash` | latest | Utility functions |

## Dev Dependencies

| Category | Package | Notes |
|----------|---------|-------|
| **Build** | `esbuild` ^0.27.4 | Dual bundle (host CJS + web ESM) |
| **TypeScript** | `typescript` ^5.3.3 | Compiler |
| **Linting** | `eslint` ^9.39.2 | Flat config (ESLint 9) |
| **Lint plugins** | `typescript-eslint`, `eslint-config-prettier` | TypeScript rules + prettier compat |
| **Testing** | `@vscode/test-cli` ^0.0.12 | Runs tests in VS Code extension host context |
| **Mocking** | `sinon` ^21.0.1 | Stubs, spies, sandboxes |
| **Packaging** | `@vscode/vsce` | Produces `.vsix` extension package |

## Frozen / Pinned Versions

- **ESLint**: Staying on 9.x — ESLint 10 has breaking config changes not yet migrated
- **OpenTelemetry**: Version-pinned to avoid peer dependency conflicts

## Technology Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| IPC | typed RPC over `postMessage` | Only reliable cross-process channel in VS Code |
| UI | Lit (LitElement) | Lightweight, no virtual DOM, native web components |
| HTTP | axios (not `fetch`) | Proxy/auth support needed for private NuGet feeds |
| XML | `@xmldom/xmldom` + `xpath` | Robust `.csproj` parsing with namespace-aware XPath |
| Dotnet integration | `child_process.spawn` | Real-time stdout streaming for progress bars |
| Testing | `@vscode/test-cli` + Mocha | Required to test VS Code API interactions |

## VS Code Extension Manifest

- **Extension ID**: `I-Synergy.NugetPackageManager.I-Synergy.NugetPackageManager`
- **Activation**: On command or workspace with `.csproj`/`.sln` files
- **Webview**: Single persistent webview panel
- **Outputs**: `releases/*.vsix`
