# Batch update: preflight conflicts, single restore, attributed retry, live progress + cancel

Status: APPROVED (user: "go for the full sequence")
Started: 2026-10-28
Predecessors: `.ai/plans/rpc-timeout-detach-and-batch-jobs.md`,
`.ai/plans/mutation-jobs-project-consolidate-cleanup.md`

## Problem

A 64-package batch writes every version, runs one `dotnet restore`, and if that restore fails
the whole transaction rolls back. The user then has to find the offending package by hand.
Non-CPM rows also restore individually (`dotnet add package` restores implicitly) before the
final restore, and the restore itself reports a single static stage/percent for minutes, with
no way to cancel from the UI.

## Sequence

### 1. Preflight the selected set before writing

- New `checkBatchUpdateAsync` RPC → `{ Conflicts: BatchUpdateConflict[] }`, backed by
  `findBatchUpdateConflictsAsync` in `host-api.ts`.
- For each affected project: load `project.assets.json` (`loadProjectDependencyGraphAsync`),
  build the effective version map (installed versions + selected versions), then:
  - fetch each selected version's dependency group for the project's TFMs
    (`fetchDependencyFrameworksAsync` + `selectDependencyGroup`) and check every declared
    range against the effective version of that dependency;
  - check ranges that *installed* parents declare on the selected packages, skipping parents
    that are themselves part of this batch (their new metadata is already covered).
- The Updates tab calls it before starting: conflicts are shown in a confirmation dialog and
  the conflicting rows are dropped when the user proceeds. No assets file → no preflight
  (restore stays the authority).

### 2. One restore, not N

- Inside a transactional batch, non-CPM `dotnet add package` calls get `--no-restore`; the
  single final restore covers all projects. Non-transactional (legacy) callers keep the old
  behaviour.

### 3. Attributed retry after a failed restore

- `restoreProjectsInternalAsync` already returns `RestoreFailure` with parsed `conflicts`.
  The batch now keeps that object and maps the contested package ids / constraint chains back
  to the requested rows → `BatchUpdateResponse.ConflictingPackages`.
- The Updates tab offers "Retry without …" using that list (one retry, no loop).

### 4. Live progress and Cancel

- `TaskExecutor.ExecuteCommandAsync` gains an optional `onProgress` callback (fires on every
  parsed stage); `restoreProjectsInternalAsync` forwards per-project/per-stage progress.
- The batch maps that onto its 80–95 % band, so a restore shows
  `Restoring <project> (2/7) — Restoring packages…` instead of a frozen bar.
- `BatchUpdateResponse.Cancelled` marks an explicitly cancelled transaction (rolled back).
- `src/web/jobs.ts` exposes `onStarted(jobId)`; the Updates tab stores the id and renders a
  **Cancel** button in the progress banner that calls `cancelJobAsync`. A cancelled job keeps
  the rows and reports "Update cancelled — the versions already written were rolled back".

## Verification

- `npm run esbuild`, `npm run lint`, `npm run test-compile`, `npm test`.
- Host: preflight detects a new-version dependency conflict and ignores a clean set; batch
  `add` calls carry `--no-restore` with exactly one `restore`; a failing restore produces
  `ConflictingPackages` + `RolledBack`; cancel sets `Cancelled`; a running restore reports a
  stage through `getJobAsync`.
- Web: conflict confirm drops the offending rows; Cancel calls `cancelJobAsync`; a cancelled
  response keeps the rows and reports cancellation.
