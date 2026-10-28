# RPC timeout: detach instead of cancel, and job-based batch updates

Status: APPROVED (user: "go")
Started: 2026-10-28

## Problem

`RPC_TIMEOUT_MS` (120 s) is a client-side deadline on calls whose runtime is proportional to
repository size. When it fires, `rpc-client.ts` posts `rpc-cancel`; the host aborts the
request signal, the transactional paths (`batchUpdatePackagesAsync`, `updateProjectAsync`)
treat that as a failure and call `rollbackFilesAsync`. A slow feed or cold NuGet cache
therefore reverts files that were already written successfully.

Raising the constant only moves the cliff, and makes the destructive path reachable even
later. The structural fix is:

1. A deadline is not a cancellation. On timeout the client stops waiting but must not abort
   host work.
2. Long mutations are jobs, not request/response calls. Start returns immediately; progress
   and the final `Result` are read from a host-side job registry (same idiom as the existing
   `ScanProgress` used by `getOutdatedPackagesAsync`).

## Scope

### Step 1 — deadline no longer cancels (all methods)

- `src/common/rpc/rpc-client.ts`: the timeout handler no longer posts `rpc-cancel`; it drops
  the pending id and fails the call with an explicit "still running in the extension host"
  message. A late response is ignored (id is no longer pending). Explicit cancellation via
  `AbortSignal` still posts `rpc-cancel`.
- This removes the rollback-on-slow-restore class of bugs for **every** long mutation,
  including `updateProjectAsync` (project tree / detail pane).

### Step 2 — batch update becomes a job

- New `src/host/utilities/batch-update-jobs.ts`: bounded, prunable registry
  (Begin/Report/Complete/Fail/Cancel/Get) holding state, stage, percent and the final
  `BatchUpdateResponse`, plus the job's own `AbortController`. Running jobs are never pruned.
- `BatchUpdateJobs.Start` runs the transaction detached from the RPC signal, so the RPC
  returning (or the webview moving on) cannot abort it. Only `cancelBatchUpdateAsync` aborts.
- New RPC methods (types → host-api → webview):
  - `startBatchUpdateAsync(req) -> { JobId }`
  - `getBatchUpdateJobAsync({ JobId }) -> { State, Stage, Percent, Response?, Error? }`
  - `cancelBatchUpdateAsync({ JobId }) -> void`
- `batchUpdatePackagesAsync` stays for compatibility and shares the same implementation, now
  with an optional progress reporter.
- `startBatchUpdateAsync` refuses to start a second job while one is running: interleaved
  snapshot/rollback transactions would let one job revert another job's writes.
- `updates-view` starts a job and polls it (immediate first poll, then 250 ms), rendering
  `Stage`/`Percent`; polling stops on completion, error, cancel and `disconnectedCallback`.

### Step 3 — verification

- `npm run esbuild`, `npm run lint`.
- Focused tests: `rpc.test.ts`, `batch-update-jobs.test.ts`, `host-api.test.ts`,
  `updates-view.test.ts`; then the full suite.
- Tests must cover: timeout sends no cancel and a late response is ignored; explicit abort
  still cancels; job lifecycle (running → completed, cancel aborts the runner, terminal
  response is served once); host job start/status/rollback; the view's start + poll path.

## Out of scope / follow-up

- `updateProjectAsync`, `consolidatePackagesAsync`, `cleanupUnusedPackagesAsync` keep the
  request/response shape for now. They inherit the Step 1 fix (no spurious rollback) but a
  client that timed out loses the final outcome until it refreshes. Converting them to the
  same job registry is the next increment.
- The per-`dotnet` 10-minute cap in `TaskExecutor` is unchanged and remains the real bound on
  host-side work.
