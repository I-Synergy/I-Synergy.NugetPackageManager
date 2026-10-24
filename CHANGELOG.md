# Changelog

## Unreleased

## 1.2.9 (2026-10-24)

- fix: hard-exclude `.ai/` and `.reasonix/` from every project, props and cleanup scan, so scratch/fake projects can never break Cleanup or be treated as solution projects.
- test: add Cleanup coverage proving `.ai/tmp/...` projects are ignored.

## 1.2.8 (2026-10-24)

- fix: use light/dark tab icons so the NuGet Package Manager editor-tab icon is visible in dark and light themes.
- perf: add a guarded literal XML target-framework fast path, falling through to assets/MSBuild for conditional TFMs.

## 1.2.7 (2026-10-24)

- fix: stop rendering the literal string `false` in the Projects pane during loading.
- perf: resolve target frameworks from the existing `obj/project.assets.json` first, avoiding one `dotnet msbuild` process per project on first load; MSBuild remains the fallback.

## 1.2.6 (2026-10-24)

- fix: Consolidate and Vulnerabilities now retain all framework-scoped CPM resolutions when a package has no single `Version`, matching Updates and Installed.
- feat: add the framework selector to Consolidate for reviewing and consolidating net10.0/net11.0 lines separately.
- docs: add the mandatory multi-TFM regression checklist to `AGENTS.md`.

## 1.2.5 (2026-10-24)

- fix: framework-scoped CPM packages with separate net10.0/net11.0 versions are no longer dropped from Updates when the package has no single version.
- feat: add the target-framework selector to the Updates tab so each framework line can be reviewed and updated separately.
- feat: show a loading indicator and status in the Projects pane while discovery and TFM resolution run; keep the previous list visible during refresh.
- feat: collapse the Projects sidebar by default.

## 1.2.4 (2026-10-24)

- docs: fix README TOC anchors, align workflow sections with the actual tab order (Browse, Installed, Updates, Consolidate, Vulnerabilities, Cleanup), and add a real VS Code Activity Bar/sidebar screenshot.
- chore: publish the corrected README and screenshots.

## 1.2.3 (2026-10-24)

- docs: refresh the README with the full-page workspace, Activity Bar badge/background checks, transactional updates, Cleanup tab, transitive vulnerability scanning, global vulnerability banner and solution-wide removal.
- chore: publish the refreshed documentation in the extension package.

## 1.2.2 (2026-10-24)

- fix: separate production and test TypeScript checks and add an ESLint-specific all-source tsconfig, resolving the final CI type-check failure.
- chore: align dependency versions so `npm ci` succeeds without legacy peer flags and the high-severity audit gate passes.

## 1.2.1 (2026-10-24)

- fix: update `@vscode/vsce` and pin patched `@azure/identity` / `@azure/msal-node` versions so `npm audit --audit-level=high` passes in CI.
- chore: refresh release artifacts and dependency lockfile.

## 1.2.0 (2026-10-24)

- feat: the NuGet Activity Bar entry is hidden until the workspace contains a supported .NET project (`.csproj`, `.fsproj`, or `.vbproj`) and updates when projects are added or removed.
- fix: uninstalling the last project reference now removes the matching `PackageVersion` entry from `Directory.Packages.props`, including conditional groups, so CPM files do not accumulate stale global references.
- feat: **Cleanup** tab replaces `Remove-UnusedPackages.ps1`: it reports unused `PackageVersion` entries, shows missing definitions, backs up each props file, and removes unused entries across all conditional groups.
- feat: **Remove from all projects** action on a selected package; per-project uninstall remains available from each project row. The solution-wide action confirms the affected projects and restores once afterward.
- feat: the NuGet UI now opens as a **full-page editor tab** instead of a terminal-area panel. A NuGet icon in the Activity Bar opens/reveals the tab, with a compact sidebar launcher and panel restoration after reload.
- feat: **marketplace-style UI** across Browse, Installed, Updates, Consolidate and Vulnerabilities — rounded cards, grouped framework sections, larger package icons, compact pill tabs, richer details header and theme-aware surfaces.

- security: workspace password scripts now require a trusted workspace and a machine-scoped `passwordScriptAllowlist`; `-ExecutionPolicy Bypass` was removed. The extension declares `capabilities.untrustedWorkspaces.supported: false`.
- security: `%VAR%` expansion is no longer applied to credentials from workspace `nuget.config`, preventing a repository from sending process-environment secrets to a feed it controls.
- security: feed credentials are limited to the configured source host and the service endpoints that source declares; package details are refused from untrusted hosts.
- security: project paths are validated with `path.resolve` + `realpath` + `path.relative` on every path-taking RPC, fixing Linux/macOS rejection and Windows prefix/traversal bypasses.
- security: package IDs and versions are validated before writing; `Directory.Packages.props` updates use a temp file + rename and abort if the file changed concurrently.
- fix: updating an unconditional CPM row now uses a dedicated `unconditional` scope and no longer rewrites framework-scoped version lines; consolidate checks the RPC result and removes only the consolidated framework line.
- fix: Consolidate now respects framework lines. Inconsistencies are keyed by package + condition + target framework, cards are grouped under Shared/netX, only the selected line's projects are written, and a blanket `Scope: all`/`first` consolidation of a framework-scoped package is refused.
- fix: CPM conditions on individual `PackageVersion` elements are parsed, resolved and updated; repeated conditions use the last document occurrence.
- fix: per-project updates carry `CpmCondition`/`CpmTfm`; ambiguous multi-framework updates fail with a clear message instead of guessing.
- fix: RPC timeouts post `rpc-cancel`; dotnet processes support abort/timeout and always release the global mutex.
- feat: vulnerability scan includes transitive packages from `project.assets.json`, marks them as transitive and shows the direct packages that pull them in.
- feat: the NuGet Activity Bar icon shows a badge with the number of available updates and clears it when everything is up to date.
- feat: a yellow vulnerability banner is shown across all tabs, with a direct link to the Vulnerabilities tab.
- fix: vulnerability matching is case-insensitive, returns the original package ID, and does not cache partial fetches.
- fix: the “latest” version is selected with SemVer sorting rather than registration-page order.
- fix: the Sort dropdown is now sent to the host and applied; tabs load only when activated.
- fix: bulk updates now run strictly one package at a time, restore each package before starting the next, show per-package progress, and stop at the first failure instead of racing concurrent CPM writes.
- fix: install/update failures are shown in the project row.
- chore: `.vscodeignore` excludes `.ai/` and `AGENTS.md` from the `.vsix`; release publishing is gated on a new version.
- chore: added `pretest`, declared all OpenTelemetry dependencies, removed unused `object-hash`, and corrected documentation drift.

- feat: native UI polish — Installed and Updates group packages by shared/netX with inline TFM chips and sticky group headers; every tab has a clear header, context count and primary action; Consolidate and Vulnerabilities use compact card rows with project chips; the details panel has a package header, labeled version selector and helpful empty state; the project tree shows selection counts and TFM metadata.
- feat: multi-framework CPM version management — conditional `ItemGroup`s are evaluated per project target framework (`dotnet msbuild -getProperty`) instead of using the first matching group. Negated conditions such as `!$(TargetFramework.StartsWith('net11.0'))` are evaluated and labelled distinctly (`not net11.0`), so both the net10.0 and net11.0 version lines can be shown and updated.
- feat: framework-aligned update suggestions — runtime-aligned packages (`Microsoft.Extensions.*`, `Microsoft.AspNetCore.*`, `Microsoft.EntityFrameworkCore.*`, `Microsoft.Maui.*`, `System.*`) recommend the highest version on the TFM's major line; the overall latest version is available as a separate, explicit action.
- feat: **Update all TFMs** action in the Updates tab — updates every framework line of the selected packages, each to its own aligned version.
- feat: Installed, Updates, Consolidate and Vulnerabilities now share one per-TFM resolution, fixing inconsistent versions (for example 10.0.13 in Installed vs 11.0.0-rc in Vulnerabilities).
- feat: CPM writes are grouped per props file — a batch update across many projects sharing one `Directory.Packages.props` now performs one read/write cycle per `(package, group)` instead of one per project. All changes are verified before writing, and a failed verification leaves the file untouched.
- feat: `ConsolidateRequest` accepts `CpmCondition`/`Scope`; consolidation is scoped to the framework group selected in the UI.
- feat: `packageSourceMapping` from `nuget.config` is parsed and honoured when resolving the latest version of a package.
- feat: vulnerability results include the affected target frameworks and deduplicate identical versions across projects.
- perf: latest-version lookups are cached per package for each refresh, so a package present in several framework groups is queried once.
- perf: project discovery excludes `bin`, `obj`, `TestResults`, `packages` and `.git` by default (`excludeGlobs`).
- feat: `.slnx` workspaces activate the extension explicitly.
- test: added table-driven CPM fixture coverage for unconditional groups, distinct positive groups, shared IDs across positive groups, negated/positive framework groups, unconditional+conditional overrides, platform-specific TFMs, attribute ordering/quoting, complex `And`/`Or` conditions, unsupported conditions and document-order precedence.
- test: added host-level integration tests for `.csproj` files targeting net10.0, net11.0, both, and platform-specific TFMs.

## 1.1.3 (2026-03-26)

- fix: CPM `Directory.Packages.props` corruption when updating multiple packages in parallel — concurrent read-modify-write operations on the same file are now serialized via a per-file mutex, preventing interleaved writes that produced malformed XML (e.g. `</Project>Project>Project>` at end of file)

## 1.1.2 (2026-03-26)

- docs: Regenerated README screenshots and demo GIF at full resolution (1280×780) showcasing all features including framework badges and filter dropdowns
- chore: Added `npm run docs` script and auto-regeneration hook — screenshots and demo GIF are automatically regenerated in the background after commits that touch `src/` or `tools/mock-api.js`

## 1.1.1 (2026-03-26)

- feat: Framework-aware CPM package updates — packages scoped to a specific target framework via `<ItemGroup Condition="...">` in `Directory.Packages.props` are now shown with a framework badge in the Installed, Updates, and Consolidate tabs, and can be filtered by framework via a dropdown in the search bar
- fix: Project discovery now respects solution files — when a `.sln` or `.slnx` file is present in the workspace root, only projects referenced by those solutions are shown (instead of all `.csproj` files in the folder)
- fix: Updates, Consolidate, and Vulnerabilities tabs no longer scan projects outside the solution when the project tree panel is hidden
- fix: Updates and Consolidate tabs no longer spin indefinitely on projects without multiple target frameworks — a stable array reference is now passed to the task runner instead of a newly allocated array on every render
- fix: Version comparison now follows NuGet SemVer rules — stable releases correctly sort above pre-release versions of the same base version
- fix: CPM `Directory.Packages.props` is now parsed once per file (cached by path) during outdated package checks, preventing redundant file reads when multiple projects share the same props file
- fix: Outdated package detection now tracks the minimum installed version across projects, ensuring all projects are flagged and updated when any one of them is behind
- security: Updated `picomatch` to fix ReDoS vulnerability (GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p)

## 1.1.0 (2026-03-25)

- fix: Batch package updates no longer abort restore on the first failure — all projects are now attempted and errors are collected
- fix: Restore errors after "Update All Selected" are now shown in the UI instead of silently going to the output log only
- fix: NU1605 transitive version conflicts are now automatically resolved during restore — when a downgrade is detected, the conflicting package is updated to the required minimum version (in `Directory.Packages.props` for CPM projects, or via `dotnet add package` for direct references) and restore is retried
- refactor: `TaskExecutor` now exposes full dotnet output on failure via `DotnetError` instead of only the last partial line, enabling precise conflict parsing

## 1.0.11 (2026-03-22)

- fix: NuGet sources dropdown now correctly respects `<clear />` in workspace `nuget.config` — sources from machine/user configs and sibling workspace folders no longer bleed through
- fix: Config processing order corrected to machine → user → workspace (was reversed), matching NuGet's own merge semantics
- fix: In multi-root workspaces, all workspace folder roots are now searched for `nuget.config` instead of only the first folder (`workspaceFolders[0]`), preventing another project's sources from appearing in the dropdown
- fix: Once `<clear />` is encountered, processing stops — sources from other workspace folders processed afterward can no longer bleed in
- fix: New sources defined in the VS Code extension settings (`i-synergy-nugetpackagemanager.sources`) are now blocked when `<clear />` is present in a workspace `nuget.config`
- fix: NuGet API instance cache and credentials cache are now cleared on webview startup, ensuring sources and credentials are always resolved fresh from `nuget.config`

## 1.0.7 (2026-03-19)

- fix: Sources dropdown now updates automatically when `nuget.config` is edited — a `FileSystemWatcher` detects changes to `nuget.config` / `NuGet.Config` and triggers a configuration reload in the webview

## 1.0.6

- chore: Internal version bump; no user-facing changes documented for this release.

## 1.0.5 (2026-03-18)

- fix: Toggling prerelease no longer causes a ~15 s delay — switching prerelease no longer clears the NuGet API factory cache (only source changes do); the package cache key already includes the prerelease flag so a new state is a natural cache miss
- fix: `ClearPackageCache(id)` now correctly removes all cache variants (`id::true`, `id::false`) instead of silently failing due to a key format mismatch
- docs: Remove three settings (`defaultSource`, `pageSize`, `showOutputOnError`) from README that are defined in package.json but never read by the extension

## 1.0.4 (2026-03-18)

- security: Patched 2 high-severity vulnerabilities via npm overrides (`serialize-javascript 7.0.3`, `diff 8.0.3`)
- security: Credentials cache now expires entries after 5 minutes (TTL) to limit credential exposure window
- refactor: Removed dead `ExecuteTask()` method — all operations go through `ExecuteCommand` with real-time stdout progress
- chore: Updated `@opentelemetry/api` → 1.9, `@opentelemetry/exporter-trace-otlp-http` → 0.213, `jsdom` → 29
- chore: Enabled stricter TypeScript options (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`) and fixed all resulting errors
- ci: Build and type-check now run on every branch push and PR; publish to Marketplace runs only on push to `main`, followed by automatic git tag
- refactor: Renamed VS Code command IDs from `i-synergy-nugetpackagemanager.*` to `nugetpackage.*`
- docs: Corrected command IDs, setting keys, marketplace install command, and `.vsix` filename in README
- test: Added `host-api.test.ts` covering `getProjects`, `getConfiguration`, `getOperationProgress`, `showConfirmation`, and `getPackages`
- fix: Registered `@/` path alias for the CommonJS test runner so host-side tests resolve correctly

## 1.0.3 (2026-03-18)

## 1.0.2 (2026-03-18)

## 1.0.1 (2026-03-17)

## 1.0.0 (2026-03-17)

- feat: Animated spinner during package install/update — shows which package is being processed; spinner replaces the action button/checkbox for the duration of the operation
- feat: Tabs (Updates, Consolidate, Vulnerabilities) auto-refresh when switched to — no manual reload needed
- feat: Retry button on Browse tab when the package feed fails to load
- fix: Prerelease toggle now immediately refreshes all tabs (Updates, Consolidate, Vulnerabilities), not just Browse
- fix: Changing the prerelease setting emits the filter event immediately without waiting for the config save round-trip
- fix: `project-row` poll timer is now cleaned up via `disconnectedCallback` — no more timer leak when the row is removed from the DOM
- security: Nonce generation replaced with `globalThis.crypto.randomUUID()` — cryptographically secure and works in both Node.js and browser contexts
- security: `updateProject` now validates that the project path is inside a workspace folder and that the source URL is a valid URL — prevents path traversal and command injection
- security: Password script executor now rejects unsupported script extensions; only `.ps1`, `.bat`, `.cmd`, `.sh` are allowed
- security: `ExecuteTask` mutex acquisition is now properly awaited; added 120 s timeout with settled guard to prevent deadlocks on task hang
- security: `search-bar` sort option is validated against an explicit allowlist before use
- security: Event listeners in `main.ts` are stored as class fields and removed in `disconnectedCallback` — prevents ghost listeners on webview reload
- fix: Switching to an already-active tab no longer fires a redundant reload request
- fix: `selectedProjectPaths` is validated after project reload — stale paths that no longer exist are removed
- fix: `consolidateAll` now surfaces a per-package failure count instead of silently swallowing errors
- fix: dotnet `stderr` tail is included in error messages for actionable failure feedback
- perf: Project file parsing parallelized across all four host handlers (`getProjects`, `getOutdatedPackages`, `getInconsistentPackages`, `getVulnerablePackages`) using `Promise.allSettled`
- perf: `getPackage` calls in the Installed tab are now rate-limited to 5 concurrent requests to prevent NuGet API throttling on large solutions
- perf: `consolidateAll` runs package consolidations in parallel instead of sequentially
- ux: Tab badge counts are preserved during reload instead of disappearing while data refreshes
- ux: Removed redundant per-tab refresh buttons (Updates, Consolidate, Vulnerabilities) — tabs refresh automatically on switch
- chore: Replace custom extension icon with official NuGet logo
- chore: RPC timeout increased from 30 s to 120 s to handle large solution restores reliably
- refactor: `executeAddPackage` and `executeRemovePackage` migrated from `vscode.Task` to `child_process.spawn` for stdout capture and real-time progress reporting

## 1.0.2 (2026-02-20)

- feat: Release script with dry-run mode and changelog automation (`tools/release.mjs`)
- feat: GitHub Actions `workflow_dispatch` trigger for one-click releases via GitHub UI
- fix: Lit component tests failing with `cssText` error (JSDOM require hook for `.css.ts` modules)
- fix: NuGetApiFactory and SearchBar tests aligned with current source code
- test: 313 tests passing (up from 197)
- chore: CI pipeline uses Node LTS, release job publishes directly

## 1.0.1 (2026-02-19)

- fix: Tab sub-views (Updates, Consolidate, Vulnerabilities) now load reliably — `setTab()` was
  calling `querySelector()` synchronously before Lit rendered the new element (microtask timing bug)
- feat: Tab badges showing result counts on Updates, Consolidate, and Vulnerabilities tabs
- fix: Selected package row now uses the active selection highlight color instead of the inactive one
- ux: Search bar is now hidden on the Updates, Consolidate, and Vulnerabilities tabs where it is not relevant
- breaking: Renamed commands `I-Synergy.NugetPackageManager.openSettings` and `I-Synergy.NugetPackageManager.reportProblem`
  to `nugetPackageManager.openSettings` and `nugetPackageManager.reportProblem` for consistency with other command IDs
- chore: Moved screenshot tooling from `screenshot-harness/` to `tools/`

## 1.0.0 (2026-02-18)

- feat: Rebrand from "NuGet Gallery" to **NuGet Package Manager** with new extension ID
- feat: Typed RPC layer with `Result<T>` for host-webview communication
- feat: UI migration from FAST Element to Lit (LitElement)
- feat: Vulnerability scanning view with severity badges and advisory links
- feat: Project tree with checkbox-based multi-project selection
- feat: Confirmation dialogs for destructive actions (uninstall, update all, consolidate)
- feat: Keyboard navigation and ARIA accessibility for all interactive elements
- feat: Central Package Management (CPM) support
- feat: NuGet.config authentication with password script decryption
- feat: Inline package version decorations in project files
- feat: Prerelease version support, pinned versions (`[x.x.x]`)
- feat: Multi-source search with "All" option
- feat: Status bar loading indicator
- refactor: Complete architecture overhaul (typed RPC replacing untyped messages)
- refactor: Resizable 3-pane layout with Split.js
- test: 202 tests (unit + component tests for all handlers and UI components)
- chore: GitHub Actions CI/CD pipeline with automatic Marketplace publish

### Credits

This extension builds upon:

- [pcislo/vscode-nuget-gallery](https://github.com/pcislo/vscode-nuget-gallery) by [Patryk Cislo](https://github.com/pcislo) (original author)
- [shis91/vscode-nuget-gallery](https://github.com/shis91/vscode-nuget-gallery) by [shis91](https://github.com/shis91) (major feature additions, CPM, authentication, test infrastructure)
