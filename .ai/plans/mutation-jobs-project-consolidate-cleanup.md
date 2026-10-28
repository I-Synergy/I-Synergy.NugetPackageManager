# Long mutations as host jobs: project update, consolidate, cleanup

Status: APPROVED (user: "go")
Started: 2026-10-28
Predecessor: `.ai/plans/rpc-timeout-detach-and-batch-jobs.md`

## Problem

Increment 1 stopped a client deadline from cancelling host work and made batch updates a
job. Four long mutations still use a single request/response call:

| RPC | Runtime driver | Rollback |
|---|---|---|
| `updateProjectAsync` | write + `dotnet restore` | yes (snapshots) |
| `consolidatePackagesAsync` | N projects write + N restores | no |
| `cleanupUnusedPackagesAsync` | full project scan + props rewrites | no (timestamped backups) |
| `restoreProjectsAsync` | N restores | no |

A webview that hits the 120 s deadline now keeps the file changes, but loses the result: the
Installed/Updates/Consolidate/Cleanup UI shows a timeout error while the host finishes, and
never refreshes. These are jobs, not queries.

## Design

### Generic registry

`src/host/utilities/operation-jobs.ts` replaces `batch-update-jobs.ts`:

- `JobRegistry<T>` — `Start` / `Report` / `Get` / `Cancel` / `HasRunning` / `WaitAsync` /
  `Reset`, same bounded retention as `ScanProgress`; running jobs are never pruned; an
  explicitly cancelled job settles as `cancelled` even when its runner returns a failure.
- `OperationJobs` singletons: `Batch` (`BatchUpdateResponse`), `Project`
  (`UpdateProjectResponse`), `Consolidate` (`void`), `Cleanup` (`CleanupUnusedResponse`),
  plus `Get(jobId)` / `Cancel(jobId)` / `Reset()` across all of them.

### RPC surface

- `startBatchUpdateAsync`, `startProjectUpdateAsync`, `startConsolidateAsync`,
  `startCleanupAsync` → `{ JobId }`. They return immediately and run the work detached from
  the request signal.
- `getJobAsync({ JobId })` → `GetJobResponse`, a discriminated union on `Kind` carrying the
  job's typed terminal `Response`.
- `cancelJobAsync({ JobId })` → aborts that job explicitly.
- The old single-call RPCs stay, delegating to the same implementations, so existing tests
  and any other caller keep working.

### Web

`src/web/jobs.ts` — `waitForJobAsync` (poll 250 ms, optional `AbortSignal`, no timers to
leak) and four typed runners (`runBatchUpdateJobAsync`, `runProjectUpdateJobAsync`,
`runConsolidateJobAsync`, `runCleanupJobAsync`).

Call sites move to the runners: `updates-view` (replacing its private polling),
`project-row`, `packages-view` (remove-from-all), `consolidate-view`, `cleanup-view`.
Progress is surfaced where the component already has a status line.

`restoreProjectsAsync` is **not** converted here: it never writes package versions, so a
timeout cannot leave the workspace modified; only its result is lost.

## Verification

- `npm run esbuild`, `npm run lint`, `npm run test-compile`, `npm test`.
- Registry tests (all kinds, cancel, failed runner, unknown id).
- Host tests: start/get/cancel for project update, consolidate and cleanup; the legacy RPCs
  still behave as before.
- Component tests: each converted call site starts a job and applies the polled result.
