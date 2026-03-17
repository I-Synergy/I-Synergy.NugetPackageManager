# Naming Conventions

## TypeScript / JavaScript

| Element | Convention | Example |
|---------|-----------|---------|
| **Files** | `kebab-case.ts` | `host-api.ts`, `project-row.ts` |
| **Classes** | `PascalCase` | `TaskExecutor`, `NuGetConfigResolver` |
| **Interfaces** | `PascalCase` (no `I` prefix) | `HostAPI`, `OperationProgress` |
| **Type aliases** | `PascalCase` | `GetProjectsRequest`, `Result<T>` |
| **Functions** | `camelCase` | `createRpcClient`, `extractResponseDetail` |
| **Variables / params** | `camelCase` | `projectPath`, `operationId` |
| **Constants (module-level)** | `UPPER_SNAKE_CASE` | `RPC_TIMEOUT_MS`, `PACKAGE_FETCH_TAKE` |
| **Private class fields** | `camelCase` (no underscore) | `this.progress`, `this.globalMutex` |
| **Unused vars** | `_camelCase` prefix | `_unused`, `_event` |
| **Enums** | `PascalCase` type + values | `TabId = "browse" \| "installed"` (use union types, not TS enums) |

## Web Components (Lit)

| Element | Convention | Example |
|---------|-----------|---------|
| **Custom element tag** | `kebab-case` | `packages-view`, `project-row` |
| **Component class** | `PascalCase` | `PackagesView`, `ProjectRow` |
| **File name** | matches tag name | `packages-view.ts`, `project-row.ts` |
| **`@state()` fields** | `camelCase` | `private selectedProjects = []` |
| **`@property()` attrs** | `camelCase` (reflects as kebab in HTML) | `@property() packageId = ""` |
| **Event handlers** | `on` + PascalCase, arrow fn | `private readonly onFilterChange = ...` |

## RPC Layer

| Element | Convention | Example |
|---------|-----------|---------|
| **Request types** | `{Action}{Entity}Request` or `{Get}{Noun}Request` | `GetPackagesRequest`, `UpdateProjectRequest` |
| **Response types** | `{Get}{Noun}Response` or `{Action}{Entity}Response` | `GetProjectsResponse`, `UpdateProjectResponse` |
| **HostAPI methods** | `camelCase` | `getProjects`, `updateProject`, `getOperationProgress` |
| **RPC wire fields** | `PascalCase` | `{ Url, SourceName, PackageId }` |

## File Organization

```
src/
  common/          # Isomorphic (bundled in both host + web)
    rpc/           # RPC protocol files
    nonce.ts
    types.ts
    logger.ts
  host/            # Node.js only (VS Code extension host)
    extension.ts
    host-api.ts
    nuget/
    utilities/
  web/             # Browser only (Lit webview)
    main.ts
    registrations.ts
    components/    # One file per Lit component
    styles/
    types.ts
```

## Test Files

- Co-located with source: `foo.ts` + `foo.test.ts`
- Test function naming: descriptive, no strict pattern required (Mocha `it()` / `describe()`)
