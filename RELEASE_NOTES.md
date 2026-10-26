# NuGet Package Manager 2.1.0

## Prerelease becomes response

- Toggling **Prerelease** clears the stale count immediately instead of keeping the previous filter's number, and the Updates tab badge shows that it is recalculating.
- Both the Updates tab badge and the Activity Bar badge now follow the new filter, including when the Updates tab is not open.
- A Prerelease change rechecks updates for the newly selected filter; switching back rechecks again.

## Live update-check progress

- The Updates tab no longer sits on an indefinite `Checking for updates…` spinner. It shows the current stage and item counts while the scan runs:
  - `Resolving package sources…`
  - `Parsing projects (2/8)`
  - `Checking latest versions (23/60)`
  - `Checking dependency constraints (3/5)`
  - `Preparing results…`
- A determinate progress bar tracks overall completion, so a slow NuGet source no longer looks like a hang.
- Progress polling stops as soon as the scan finishes, fails or the view is closed.

## Everything in 2.0.0

- Dependency-aware update suggestions with a **Dependency conflicts** section and restore rollback.
- Per-target-framework Central Package Management resolution, including framework-scoped versions.
- Faster Updates scanning: persisted last scan, disk-cached NuGet HTTP responses, reused registration dependency groups and configurable concurrency.
