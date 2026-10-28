# NuGet Package Manager 2.2.0

## Updates that finish

- A slow update on a large solution is no longer cancelled and reverted by the webview's 120 s request deadline. The deadline now only stops the webview waiting; the extension host finishes the work. Files are rolled back only for a real write/restore failure or an explicit cancel.
- Every long operation runs as a host-side job — batch update, single install/update/uninstall, consolidation and cleanup. A job keeps running if the tab is closed, reports its stage and percentage, and can be cancelled.
- Only one batch update runs at a time, so two transactions can never overwrite each other.
- A transactional batch restores once for the whole selection instead of once per non-CPM package (`dotnet add --no-restore`).

## Fewer failed batches

- Before writing, a multi-package update is checked against the restored dependency graph: the new versions' own requirements and the ranges installed packages declare. Conflicts are listed in a confirmation dialog and those rows are skipped, so one incompatible package no longer fails the other 63.
- If the final restore still fails, the rollback names the packages the diagnostics point at and offers **Retry without** them.
- The restore phase streams `dotnet`'s own stages per project, so a multi-minute restore no longer looks like a hang.

## Cancel anywhere

- **Cancel** is available while a batch update runs, on a busy project row, on a consolidating card, during cleanup and during "remove from all projects" (which stops before touching the remaining projects).
- Each cancellation reports what happened: versions rolled back, versions left applied, or removals kept with their backups.

## Everything in 2.1.0

- Prerelease changes clear and recheck the update count on both the Updates tab badge and the Activity Bar badge.
- The Updates tab shows live progress while checking (`Parsing projects (2/8)`, `Checking latest versions (23/60)`, …) with a determinate progress bar.
