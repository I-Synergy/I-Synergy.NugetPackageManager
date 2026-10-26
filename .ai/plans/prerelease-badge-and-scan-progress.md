# Plan: Prerelease-aware update badge + verbose update-check progress

Status: DONE
Author: Reasonix Code
Date: 2026-10-26

## Problem

1. **Stale update count after a Prerelease toggle.**
   `packages-view` only refreshes the Updates tab badge / Activity Bar badge through
   `RefreshUpdateCountAsync` (project selection, activation) or through a `count-changed`
   event from a *mounted* `updates-view`. `UpdatePackagesFiltersAsync` never refreshes the
   count when `Prerelease` changes:
   - On any tab other than Updates the child is not rendered, so no scan is triggered and
     both badges keep showing the prerelease count.
   - On the Updates tab the tab badge does refresh after the scan, but the Activity Bar badge
     (`hostApi.updateBadgeAsync`) is never updated from that scan, and the old number stays
     visible for the whole (multi-second) rescan with no indication that it is recalculating.

2. **The update check looks stuck.**
   The Updates tab shows only `spinner + "Checking for updates..."`. The host already
   computes per-batch progress for the status bar (`Checking updates (x/y)...`) but never
   exposes it to the webview.

## Changes

1. **`src/common/rpc/types.ts`**
   - `GetOutdatedPackagesRequest.ScanId?: string`.
   - New `GetOutdatedScanProgressRequest { ScanId }` and
     `GetOutdatedScanProgressResponse { Active, Stage, Percent, Completed, Total }`.
   - Add `getOutdatedScanProgressAsync` to `HostAPI`.

2. **`src/host/utilities/scan-progress.ts` (new)**
   In-memory registry keyed by `ScanId`: `Begin`, `Report`, `Complete`, `Get`, with pruning of
   entries older than 10 minutes and a cap on tracked scans.

3. **`src/host/host-api.ts`**
   - Report stages from `getOutdatedPackagesAsync` when a `ScanId` is supplied:
     resolving sources → reading/parsing projects (`n/N`) → checking latest versions
     (`n/N`, 20–90 %) → checking dependency constraints (`n/N`, 90–98 %) → preparing results.
   - Always clear the entry in `finally` (including the cached/prefer-cache and error paths).
   - Implement `getOutdatedScanProgressAsync`.

4. **`src/web/components/updates-view.ts`**
   - Generate a `ScanId` per task run, pass it to the host, and poll
     `getOutdatedScanProgressAsync` every ~400 ms while the task is pending; stop on
     completion, error, task cancellation and `disconnectedCallback`.
   - Render stage text, `completed/total` counts and a determinate progress bar in the loading
     block (`aria-live="polite"`).
   - Emit `badge-changed` with `{ Count, BlockedCount }` after a scan so `packages-view` can
     update the Activity Bar badge (keeps the existing `count-changed` number contract for
     other consumers).

5. **`src/web/components/packages-view.ts`**
   - `UpdatePackagesFiltersAsync`: detect a Prerelease change, immediately clear the stale
     count and mark it as recalculating (tab badge renders `…`), then:
     - if `updates-view` is mounted, its task re-runs and `badge-changed` settles the count;
     - otherwise call `RefreshUpdateCountAsync()` so the count is recomputed for the badge.
   - `@badge-changed` handler waits for `hostApi.updateBadgeAsync` so the Activity Bar badge
     follows every scan.

6. **Tests**
   - `src/web/components/packages-view.test.ts`: Prerelease toggle clears the badge and
     refreshes it without an Updates tab mounted; Prerelease toggle does not force-reload the
     NuGet cache.
   - `src/web/components/updates-view.test.ts`: progress polling drives stage/count/percent;
     `badge-changed` carries the blocked count; polling stops after the scan.
   - `src/host/host-api.test.ts`: a scan with a `ScanId` reports progress and clears it when
     done.
   - Add mock `getOutdatedScanProgressAsync` to existing webview test mocks.

## Verification

- `npm run esbuild`
- `npm run lint`
- `npm test` (full suite; focused runs first while iterating)

## Out of scope

- Streaming `complete/total` for the cache-warm paint (it is a single fast cache read).
- Changing host-side scan concurrency or the status bar indicator.
