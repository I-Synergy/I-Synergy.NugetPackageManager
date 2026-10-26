# NuGet Package Manager 2.0.0

## Breaking: new identity

- The extension is now **NuGet Package Manager for VS Code** (`thenugetpackagemanager`, ID `I-Synergy.thenugetpackagemanager`).
- Commands, the webview panel, views and settings moved to the `theNugetPackageManager.*` namespace.
- The legacy `i-synergy-nugetpackagemanager.*` settings and `nugetpackage.*` command IDs were removed without compatibility shims, so existing keybindings and settings must be recreated.
- The view container ID changed, so its Activity Bar placement resets once.
- The Marketplace treats this as a new listing, so existing installations will not auto-update.

## Dependency-aware updates

- Restore failures now surface the real `dotnet` diagnostics, including the full `NU1107` constraint chain and the dependencies that declare the conflicting ranges.
- Update suggestions are capped to versions accepted by installed dependencies, using `project.assets.json` and NuGet dependency metadata.
- Unsafe versions appear in a **Dependency conflicts** section with the blocked version and the packages or ranges that pin it; the latest-overall action remains an explicit override.
- A failed restore after a single install, update or uninstall rolls the project file and `Directory.Packages.props` back instead of leaving the workspace modified.
- The extension restores after a write and never invokes `dotnet build`.

## Faster updates

- The Updates tab paints the last persisted scan immediately and refreshes in the background; selections survive the refresh.
- NuGet HTTP responses are cached on disk for 30 minutes under the extension's global storage, and Reload clears the cache.
- `dependencyGroups` embedded in registration data are reused, so package details and constraint checks no longer issue a second request.
- Constraint checks fetch metadata only for packages that directly declare the dependency, instead of the whole transitive closure.
- Latest-version check concurrency is configurable through `theNugetPackageManager.updateCheckConcurrency` (default 8).

## Diagnostics

- Per-phase timings for the Updates scan are logged: project parse, framework sources, latest-version checks and constraint checks.
