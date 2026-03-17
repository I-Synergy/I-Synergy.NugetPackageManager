# Changelog

## Unreleased

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

## 1.0.3 (2026-02-20)

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
- breaking: Renamed commands `nuget-packages-manager.openSettings` and `nuget-packages-manager.reportProblem`
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
