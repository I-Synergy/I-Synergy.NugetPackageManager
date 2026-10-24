# NuGet Package Manager 1.2.5

## Fixes and UI

- Fixed multi-target CPM packages disappearing from Updates on net11.0.
- Added the framework selector to Updates for per-framework review and updates.
- Added a Projects loading indicator, kept the previous list during refresh, and collapsed the Projects sidebar by default.

## Documentation

- Added a real VS Code screenshot showing the NuGet Activity Bar/sidebar launcher.
- Fixed README TOC anchors and aligned the workflow sections with the actual tab order.
- Refreshed the README for the full-page workspace, Activity Bar badge and background checks, transactional updates, Cleanup tab, transitive vulnerabilities, global vulnerability banner and solution-wide removal.
- Regenerated screenshots and the demo GIF for the current marketplace-style UI.

## Maintenance

- Aligned production/test TypeScript scopes and added an ESLint-specific tsconfig.
- Aligned dependency peers so `npm ci` no longer needs legacy flags.
- `npm audit --audit-level=high` passes in CI.

## Highlights

- **Full-page package workspace** — the NuGet UI now opens in an editor tab instead of the terminal area. A NuGet icon in the Activity Bar opens or reveals it, with a compact sidebar launcher.
- **Marketplace-style interface** — rounded cards, grouped framework sections, pill tabs, richer package details and theme-aware surfaces across all screens.
- **Cleanup tab** — replaces `Remove-UnusedPackages.ps1`. It reports unused `PackageVersion` entries, shows packages used but missing from `Directory.Packages.props`, backs up each props file, and removes unused entries across conditional groups.
- **Solution-wide package removal** — remove a package from every project that references it, alongside the existing per-project uninstall.
- **Transactional updates** — updates are written one package at a time, restored once after the full set, and rolled back if a write or restore fails.
- **Deeper vulnerability scanning** — transitive packages from `project.assets.json` are included, marked as transitive, and shown with the direct packages that pull them in. A yellow banner appears across all tabs when vulnerabilities exist.
- **Update badge** — the Activity Bar icon shows the number of available updates. Checks run from the extension host every 15 minutes while the icon is visible, even when the page is closed.

## Multi-framework CPM

- Conditional `ItemGroup`s are resolved against each project's real target frameworks instead of using first-match attribution.
- Negated conditions are evaluated and labelled distinctly, e.g. `not net11.0`.
- Framework lines are never consolidated accidentally; consolidation is scoped to one condition and target framework.
- Runtime-aligned packages stay on the target framework's major line, with the overall latest version available as an explicit action.

## Reliability and security

- CPM writes use snapshots, single-read/write batches, verification and a per-file mutex.
- Stale global `PackageVersion` entries are removed when the last project reference is uninstalled.
- Project paths, package IDs, versions and source URLs are validated before writes.
- Password scripts require a trusted workspace and a machine-scoped allowlist.
- Workspace `%VAR%` expansion is disabled for credentials.
- RPC cancellation and dotnet process timeouts release locks and stop work cleanly.

## Upgrade notes

- The NuGet view is no longer in the bottom panel. Use the Activity Bar icon or **`NuGet Package Manager: Open Packages`**.
- The Activity Bar icon is hidden in workspaces without a supported `.csproj` / `.fsproj` / `.vbproj`.
- Bulk update behavior is now transactional; on restore failure, file snapshots are restored and the operation reports a rollback.
- The Cleanup tab creates timestamped backups before modifying `Directory.Packages.props`.

## Fixes

- Corrected per-framework Installed, Updates, Consolidate and Vulnerabilities results.
- Fixed ambiguous updates, stale row removal, vulnerability case matching, SemVer latest selection, RPC cancellation and parallel CPM write corruption.
- Fixed documentation, screenshots, packaging and CI release gating.

**Full changelog:** [CHANGELOG.md](CHANGELOG.md)
