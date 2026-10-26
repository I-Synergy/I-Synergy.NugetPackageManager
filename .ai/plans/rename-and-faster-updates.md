# Rename to TheNugetPackageManager + faster Updates

Status: DONE (Phase 3 optional deferred)
Started: 2026-10-26
Scope: extension identity and internal IDs, Updates warm start, NuGet request/cache work

## Decisions (confirmed)

**D1 — Extension identity: full rename.**

| Field | Current | New |
|---|---|---|
| `package.json.name` | `i-synergy-nugetpackagemanager` | `thenugetpackagemanager` |
| `package.json.displayName` | `I-Synergy NuGet Package Manager` | `TheNugetPackageManager` |
| `package.json.publisher` | `I-Synergy` | unchanged |
| Extension ID | `I-Synergy.i-synergy-nugetpackagemanager` | `I-Synergy.thenugetpackagemanager` |

The Marketplace treats this as a **new extension**: existing installs do not
auto-update and per-extension state (`globalState`, `secrets`) starts empty. The
old listing needs a deprecation/redirect notice. This is a breaking change and
gets a `breaking:` entry in the CHANGELOG.

**D2 — Internal identifiers: migrate everything.** Command IDs, the webview
panel ID, view container/view IDs, configuration keys and the version
`globalState` key all move to the new namespace. Legacy compatibility shims
(below) keep existing keybindings and settings working for one release.

## Phase 0 — Rename identity and identifiers

### Identifier map

| Kind | Current | New |
|---|---|---|
| Extension ID | `I-Synergy.i-synergy-nugetpackagemanager` | `I-Synergy.thenugetpackagemanager` |
| Commands | `nugetpackage.open`, `.install`, `.update`, `.remove`, `.openSettings`, `.reportProblem` | `theNugetPackageManager.open`, `.install`, `.update`, `.remove`, `.openSettings`, `.reportProblem` |
| Webview panel | `nugetpackage.panel` | `theNugetPackageManager.panel` |
| View container | `i-synergy-nugetpackagemanager` | `theNugetPackageManager` |
| View | `i-synergy-nugetpackagemanager.launcherView` | `theNugetPackageManager.launcherView` |
| Settings | `i-synergy-nugetpackagemanager.*` (11 keys) | `theNugetPackageManager.*` |
| `globalState` | `i-synergy-nugetpackagemanager.version` | `theNugetPackageManager.version` |
| Webview title / element | `I-Synergy` branding; `<i-synergy-nugetpackagemanager>` | `TheNugetPackageManager`; `<the-nuget-package-manager>` |
| Output channel | `NuGet Package Manager` | `TheNugetPackageManager` |
| Telemetry service | `i-synergy-nugetpackagemanager` | `thenugetpackagemanager` |

### Compatibility shims (removed before release)

The legacy namespace was removed completely at the user's request. The final
state has **no** `i-synergy-nugetpackagemanager.*` settings, **no**
`nugetpackage.*` command aliases, **no** legacy panel serializer and **no**
legacy activation event. Only `theNugetPackageManager.*` is read and
contributed. The mapping table above is kept as the historical rename record.

### Files

| File | Change |
|---|---|
| `package.json` | `name`, `displayName`, command IDs/titles, `activationEvents` (`onWebviewPanel:theNugetPackageManager.panel`), `menus` `when` clauses, view container/view IDs, all `contributes.configuration` keys, `configuration.title` |
| `package-lock.json` | `"name": "thenugetpackagemanager"` (both occurrences) |
| `src/common/configuration.ts` | **new** namespace helpers + legacy fallback + one-time settings copy |
| `src/common/logger.ts` | output channel, telemetry service name, config namespace (both watchers), log level read |
| `src/host/extension.ts` | command registrations + legacy aliases, panel serializer (both IDs), `createTreeView` ID, `globalState` key, webview title, custom element, tree item command/label, issue URL stays until the repository is renamed |
| `src/host/host-api.ts` | replace all `getConfiguration("i-synergy-nugetpackagemanager")` with the shared helper |
| `src/host/utilities/{nuget-config-resolver,package-version-decorator,status-bar-utils}.ts` | same helper |
| `src/web/main.ts` | `@customElement("the-nuget-package-manager")` |
| `tools/index.html` | element tag and CSS selector |
| `.github/workflows/ci.yml` | VSIX output `TheNugetPackageManager.vsix`; artifact name |
| `README.md` | title, marketplace badge/link (`itemName=I-Synergy.thenugetpackagemanager`), install command, VSIX filename, command/settings tables, architecture diagram, clone URL (keep GitHub path until the repo is renamed) |
| `CHANGELOG.md` | `breaking:` rename entry + `feat:` new IDs; history preserved |
| `docs/publishing.md`, `docs/design/marketplace.html` | product name, VSIX name, marketplace ID |
| `.ai/session-context.md`, `.ai/project/tech-stack.md`, `.ai/plans/*` | new product/ID names where they refer to this extension (leave `I-Synergy.Framework` references alone) |

### Tests

- `configuration.ts`: new key wins, old key fallback, default, target-aware
  one-time copy (stub `workspace.getConfiguration`).
- `logger`: level read from the new key and from the legacy key.
- Manifest check: a unit test (or `vsce ls` in CI) asserting the extension name,
  command IDs, panel ID and view IDs match the new namespace.
- Update tests that hard-code command/config IDs (search
  `i-synergy-nugetpackagemanager` and `nugetpackage.`).

### Verification

```bash
npm run esbuild
npm run lint
npm run test-compile
npm test
npm run package
npx @vscode/vsce ls
```

Manual in a clean profile: extension shows as
`I-Synergy.thenugetpackagemanager` / `TheNugetPackageManager`; commands resolve
under the new IDs; legacy keybindings still invoke them; settings set under
`i-synergy-nugetpackagemanager.*` are honoured and copied to
`theNugetPackageManager.*`; output channel and webview use the new name; view
placement resets once (expected).

### Screenshots

`docs/images/*.png` show the old title. Regenerate with `npm run docs` as a
separate explicit step (it installs Playwright/Chromium and adds dev
dependencies), or capture the affected screens manually.


## Phase 1 — Warm start: persisted scan + stale-while-revalidate

This is the change that reproduces Visual Studio's "almost instant" feel.

Measured baseline on `I-Synergy.Framework`: 101 unique packages, the
latest-version phase issues one search request per package at concurrency 5;
TFM resolution is not the bottleneck (86 projects literal XML, 16 assets,
0 MSBuild). The wait is network + no cached first paint.

### Host

- New `src/host/scan-cache.ts`:
  - `LoadAsync`, `SaveAsync`, `ClearAsync` against `ExtensionContext.workspaceState`
    (fall back to a module-level map in tests).
  - Entry: `{ SchemaVersion, Key, ScannedAt, Packages, BlockedPackages }`.
  - Key: sorted project paths + source URL + prerelease + `excludeGlobs`.
  - Ignore entries with a different schema version.
- `getOutdatedPackagesAsync`:
  - `request.PreferCache === true` → return the stored entry immediately with
    `FromCache: true, ScannedAt`, and do **not** scan.
  - normal request → run the scan, then save the result.
  - response gains `FromCache?: boolean`, `ScannedAt?: string`.
- Clear/invalidate when the source list, prerelease flag or project set
  changes (the key already covers this), on schema bump, or from a command.

### Webview

- `updates-view`: on activation, first call with `PreferCache: true` and render
  rows immediately; then run the live scan. While the live scan runs show
  `Refreshing…` in the subtitle (keep the cached rows visible).
- Preserve `Selected` by `(Id, CpmCondition, CpmFramework)` across the replace.
- If the live scan fails, keep the cached rows and show the error in
  `statusText`; never blank the list.
- `LoadOutdatedPackagesAsync` keeps its public signature (called from
  `packages-view` on tab switch).

### Tests

- Cache round-trip and schema invalidation (stubbed `workspaceState`).
- `PreferCache` returns the stored payload without calling the NuGet API.
- Live scan saves a new entry.
- Component: cached rows render before the live response, selections survive,
  live failure keeps rows, one `count-changed` per final list.
- Host: cache key changes when source/prerelease/project paths change.

## Phase 2 — Fewer requests and an HTTP cache

- Retain dependency groups per version in `NuGetApi.GetPackageAsync` (the
  registration index already carries `catalogEntry.dependencyGroups`).
  Add `GetPackageDependenciesAsync(id, version)` served from that data, with a
  leaf-URL fetch only when the feed omitted the groups.
  `fetchDependencyFrameworksAsync` in `host-api.ts` uses it, so constraint checks
  stop making a second request per source package.
- Add a disk HTTP cache for NuGet GETs under
  `context.globalStorageUri/nuget-http`, keyed by URL with ETag/Last-Modified
  and a TTL. Wire it through `nugetApiFactory` (initialize with the cache dir).
  Clear it from Settings/Cleanup if it grows beyond a size cap.
- Latest-version phase: keep the search endpoint (one request per package, full
  version list), or use the flat-container `index.json` if a benchmark shows it
  is faster. Add `i-synergy-nugetpackagemanager.updateCheckConcurrency`
  (default 8, current hard-coded 5) and honour it.
- Tests: dependency data served without a second GET; cache hit/miss/expiry;
  concurrency setting; force-reload bypasses the disk cache.

Expected: warm scans near-instant; cold scans moderately faster; constraint
checks add no requests. VS-like behaviour comes from Phase 1 + the disk cache,
not from MSBuild tuning.

## Phase 3 — Persisted TFM resolution (optional, deferred)

- `ProjectFrameworkResolver` already caches in memory and prefers literal XML
  then `project.assets.json`. Persist the resolved result in `workspaceState`
  keyed by the same mtime/size fingerprint used by `BuildCacheKeyAsync`, so a
  restart does not re-read/evaluate unrestored projects.
- Not needed for repositories that have assets (including the framework repo
  measured above); only helps a first run on an unrestored tree.

## Non-goals

- Embedding MSBuild or keeping a long-lived MSBuild node (Visual Studio's
  advantage); a VS Code extension cannot access the C# project system's
  evaluated model.
- A full NuGet dependency resolver.
- Renaming the GitHub repository or the Marketplace publisher.

## Verification (all phases)

```bash
npm run esbuild
npm run lint
npm run test-compile
npm test
npm run package
```

Manual: run the extension against `I-Synergy.Framework`, open Updates twice
(second must paint from cache), check the new log lines
(`getOutdatedPackages: … Parsed … TFM sources …`, `Latest-version checks …`,
`Dependency-constraint checks …`, `… total`) and confirm no `dotnet build`.

## Risks

- **New extension ID** (D1): no auto-update path, listed separately. Needs a
  deprecation notice on the old marketplace item.
- **Cached data staleness**: always refreshed in the background; the response
  carries `ScannedAt` and the UI shows `Refreshing…`.
- **Disk cache growth**: cap size and expose a clear-cache action.
- **Screenshots** will show the old name until `npm run docs` is run.
