# NU1107 / transitive version-conflict handling

Status: DONE
Started: 2026-10-26
Scope: phases 1–3 (diagnostics, transactional single update, provider-aware suggestions)
Owner: Reasonix Code

## Problem

Updating the net11.0 framework line produced an unsatisfiable graph:

```text
Sample.EventSourcing.Api -> I-Synergy.Framework.EventSourcing.EntityFramework
  -> Microsoft.EntityFrameworkCore.Relational (>= 11.0.0-rc.3.26522.148)
Sample.EventSourcing.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2
  -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0-rc.2.26504.105)
```

`NU1107 Version conflict detected` — the provider's `[exact]` pin and the
framework's `>= rc.3` cannot both hold. Npgsql 11.0.0-rc.2 is the newest
published provider, so no version combination satisfies both.

Current behaviour (verified in code):

| Area | Today | Gap |
|---|---|---|
| Updates scan (`src/host/host-api.ts:856-880`) | Each package's latest is computed independently; alignment only caps the TFM major | No dependency-graph awareness; suggests EF Core rc.3 next to a provider that pins rc.2 |
| Restore conflicts (`host-api.ts:1651-1666`, `1847-1896`) | Only `NU1605` downgrades are parsed and auto-fixed | `NU1107`, `NU1608`, `NU1102`, `NU1109` are ignored |
| Batch update failure (`host-api.ts:1705-1732`) | Transactional rollback works, but the dotnet output is discarded | UI shows "There may be version conflicts — try updating all related packages together" (`:1155`), which cannot work here |
| Single update (`host-api.ts:586-609`) | Writes the CPM version, runs restore, returns `fail` — **no rollback** | A failed restore leaves `Directory.Packages.props`/csproj broken |
| Consolidate | Compares the same package across projects | Cannot see a conflict between different packages |

## Goals

1. Make every restore failure self-explanatory: surface the real `dotnet`
   diagnostics, including the NU1107 constraint chain.
2. Never leave the workspace modified when a single-package update fails to
   restore.
3. Stop offering update versions that would immediately break restore because a
   direct dependency in the same TFM group pins an incompatible version.

## Non-goals

- A full NuGet dependency resolver / constraint solver. `dotnet restore` stays
  the authority.
- Auto-fixing NU1107. The safe remedy is a downgrade or a deliberate override,
  which is a user decision.
- Fixing the NU1605 auto-fix write scope (it uses the default `scope: "first"` in
  `CpmResolver.UpdatePackageVersionAsync`). Tracked as a follow-up; see
  **Risks / follow-ups**.
- Changing anything in `D:/Projects/I-Synergy/I-Synergy.Framework`.

## Design

### Phase 1 — Restore diagnostics

New utility `src/host/utilities/restore-diagnostics.ts`:

```ts
export type RestoreConstraint = {
  chain: string;        // "Sample.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 -> ..."
  range: string;        // "= 11.0.0-rc.2.26504.105" | ">= 11.0.0-rc.3.26522.148"
};

export type RestoreConflict = {
  code: "NU1107" | "NU1605" | "NU1608" | "NU1102" | "NU1109";
  packageId: string;
  suggestedVersion?: string;   // the "install/reference X <v>" hint, when present
  projectName?: string;
  constraints: RestoreConstraint[];
};

export function ParseRestoreConflicts(output: string): RestoreConflict[];
export function FormatRestoreConflicts(conflicts: RestoreConflict[]): string;
```

- Parse `error <CODE>:` lines plus the indented continuation lines that follow
  until the next error/blank line. NU1107, NU1608 and NU1109 share the
  "Version conflict / package downgrade / approximate" family; NU1102 is
  "Unable to find package X with version (>= …)".
- `FormatRestoreConflicts` produces the actionable one-liner used by the UI, e.g.
  `NU1107 Microsoft.EntityFrameworkCore.Relational — Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 requires = 11.0.0-rc.2.26504.105; I-Synergy.Framework.EventSourcing.EntityFramework requires >= 11.0.0-rc.3.26522.148`.
- `ParseNu1605Conflicts` in `host-api.ts` is replaced by the new parser; the
  auto-fix keeps its current behaviour but consumes `RestoreConflict`.
- `restoreProjectsInternalAsync` returns a structured result
  (`{ failedProjects, conflicts }`) instead of `string | null`.
  `restoreProjectsAsync` and `batchUpdatePackagesAsync` set
  `RestoreError` from `FormatRestoreConflicts`, and log the full output.
- `restoreWithConflictResolutionAsync` parses only NU1605 for auto-fix; any
  other code rethrows with the formatted detail. Pass `signal` to the initial
  `ExecuteCommandAsync` call (currently omitted at `host-api.ts:1850-1854`).
- Rollback is unchanged and still runs before the error is reported.

### Phase 2 — Transactional single update

`updateProjectAsync` (`host-api.ts:512-619`):

- Snapshot the project file plus its `Directory.Packages.props` (when CPM is
  enabled) before writing — reuse `snapshotFilesAsync`.
- Run restore. On failure: `rollbackFilesAsync`, re-run a non-conflict-resolving
  restore, then return `fail("Update rolled back: " + FormatRestoreConflicts(...))`.
- Apply to `UNINSTALL` as well when it modifies CPM (`cleanupUnusedCpmPackageAsync`).
- Keep `skipRestore` semantics: a skipped restore means no rollback trigger.
- The batch path keeps its existing transaction; only the error payload changes.
- Shared helper so both paths use the same snapshot/rollback code.

### Phase 3 — Provider-aware update suggestions

New utility `src/host/utilities/nuget-version-range.ts`:

```ts
export function SatisfiesRange(version: string, range: string): boolean;
```

- Supports NuGet ranges `[1.0.0]`, `[1.0,2.0)`, `(,2.0]`, `[1.0,)`, plain
  versions (`>= v`), floating `1.*`/`1.2.*`, and prerelease labels.
- Tolerance: an unparseable range returns `true` (never hide an update because
  parsing failed) and logs at debug level.

Host changes in `getOutdatedPackagesAsync`:

1. Build a per-group direct-package index from the already-parsed projects:
   `Map<condition, Array<{ id, version, framework }>>` (a framework-scoped
   version is its own group; unconditional packages share the `""` group).
2. Only for groups that have at least one candidate update, resolve dependency
   metadata for the group's direct packages:
   - `GetPackagesAsync(id, /*prerelease*/ true)` → find the leaf whose version
     equals the installed version → `PackageVersion.Id` is the registration leaf
     URL (`src/host/nuget/api.ts:149-165`).
   - `GetPackageDetailsAsync(leafUrl)` → `dependencies.frameworks` map.
   - Choose the dependency group for the row's TFM: exact TFM, else same major
     (`getTfmMajorVersion`), else the first group. Cache per
     `sourceUrl + id + version` for the process lifetime (version metadata is
     immutable). Failures are logged and treated as "no constraint".
3. For each candidate version (already filtered by prerelease and, for
   `frameworkAlignedPackages`, by TFM major), intersect the ranges declared on
   the candidate package by the group's installed direct packages.
   `safeVersion` = the highest available candidate version satisfying all
   ranges.
4. Response mapping (`OutdatedPackage` in `src/common/types.d.ts`):
   - `LatestVersion` = `safeVersion` when it is greater than `InstalledVersion`.
   - `LatestOverallVersion` = the overall latest when it is newer than
     `LatestVersion` and did not satisfy the constraints.
   - New optional `BlockedBy?: Array<{ PackageId: string; Version: string; Range: string }>`.
   - When no available version satisfies the constraints (`safeVersion` is not
     newer than installed), the row is omitted and the reason is logged.
     `GetOutdatedPackagesResponse` gains an optional
     `BlockedPackages?: Array<{ Id; InstalledVersion; BlockedVersion; Reason; BlockedBy }>`
     that `updates-view` renders as a **Dependency conflicts** section (package,
     `installed → blocked` version, and the pinning packages/ranges).
5. Constraints are evaluated against the **installed** version of each
   dependent package. A dependent that is itself being updated may relax the
   pin in the same run; that case stays conservative (we under-suggest, never
   over-suggest). Documented in the utility and the README.

UI changes:

- `OutdatedPackageViewModel` (`src/web/types.ts:118-146`) passes through
  `BlockedBy`.
- `updates-view` row (`:355-406`): warning icon with a title listing
  `pkgId version (range)` when `BlockedBy` is non-empty; the "latest overall"
  button stays available and its title explains that it overrides the pin.
- Footer line for `BlockedPackages` (implemented as the **Dependency conflicts**
  section with per-package details).

### Files

| File | Change |
|---|---|
| `src/host/utilities/restore-diagnostics.ts` | new parser + formatter |
| `src/host/utilities/restore-diagnostics.test.ts` | new tests (real NU1107 sample, NU1605, NU1608, NU1102, multi-error output) |
| `src/host/utilities/nuget-version-range.ts` | new range matcher |
| `src/host/utilities/nuget-version-range.test.ts` | new tests (exact, ranges, floating, prerelease, invalid) |
| `src/host/host-api.ts` | parser wiring, structured restore result, transactional `updateProjectAsync`, constraint check in `getOutdatedPackagesAsync` |
| `src/host/host-api.test.ts` | restore-failure propagation, rollback on single update, pinned-candidate suggestion (mocked NuGet API) |
| `src/common/types.d.ts` | `OutdatedPackage.BlockedBy`, `GetOutdatedPackagesResponse` blocked list |
| `src/web/types.ts`, `src/web/components/updates-view.ts` (+ `.test.ts`) | blocked reason + footer |
| `README.md`, `CHANGELOG.md` | behaviour and diagnostics documentation |

### Tests (regressions)

- Unit: the exact `NU1107` output from the report parses into one conflict with
  two constraints (`= 11.0.0-rc.2.26504.105`, `>= 11.0.0-rc.3.26522.148`).
- Unit: `SatisfiesRange("11.0.0-rc.3.26522.148", "[11.0.0-rc.2.26504.105]")`
  is `false`; `SatisfiesRange("11.0.0-rc.2.26504.105", "[11.0.0-rc.2.26504.105]")`
  is `true`.
- Host: `getOutdatedPackagesAsync` with a mocked provider whose installed
  version pins the candidate exactly → `LatestVersion` equals the pin, never the
  newer version; `BlockedBy` names the provider.
- Host: `batchUpdatePackagesAsync` / `restoreProjectsAsync` with
  `TaskExecutor.ExecuteCommandAsync` throwing a `DotnetError` containing the
  NU1107 text → `RestoreError` contains the package and both constraints;
  files are rolled back.
- Host: `updateProjectAsync` on a CPM package, restore throws → `Directory.Packages.props`
  is byte-identical to before the call.
- Component: blocked row renders the warning and the footer renders the count.

## Verification

```bash
npm run esbuild
npm run lint
npm run test-compile
npm test
```

Phases land as separate commits (`fix:` diagnostics, `fix:` transactional
single update, `feat:` constraint-aware suggestions) with README/CHANGELOG
updates. Full suite before the final commit.

## Risks / follow-ups

- **Constraint check cost.** Dependency metadata is fetched only for groups
  with candidates, at concurrency 5, and cached per version. A large solution
  adds one registration leaf request per distinct direct package per scan; the
  cache makes repeat scans free. If this proves slow, gate it behind a setting.
- **Conservative suggestions.** The check uses installed dependents, so a
  dependent updated in the same run may relax the pin later than we predict.
  Under-suggesting is the intended failure mode.
- **NU1605 auto-fix scope (follow-up).** `restoreWithConflictResolutionAsync`
  calls `CpmResolver.UpdatePackageVersionAsync(projectPath, packageId, version)`
  without a condition, which defaults to `scope: "first"` and can rewrite the
  wrong framework group in a multi-TFM props file. Recommend a follow-up that
  resolves the matching `CpmResolutions` entry and passes `condition`/`group`,
  or refuses to auto-fix when ambiguous.
- **Repairing an already-broken workspace.** Phase 3 prevents the suggestion but
  does not downgrade an existing broken state. With phase 1, the user gets a
  precise message and can pick the pinned version in the Details panel. A
  dedicated "repair" action is out of scope.

## Appendix — immediate fix for the framework repo (not part of this change)

In `D:/Projects/I-Synergy/I-Synergy.Framework/Directory.Packages.props`, net11.0
group, put the EF Core set back on the rc.2 line while Npgsql is rc.2:

```xml
<PackageVersion Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="11.0.0-rc.2.26504.105" />
<PackageVersion Include="Microsoft.EntityFrameworkCore.InMemory" Version="11.0.0-rc.2.26504.105" />
<PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="11.0.0-rc.2.26504.105" />
<PackageVersion Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="11.0.0-rc.2" />
```

`Microsoft.AspNetCore.Identity.EntityFrameworkCore` must move too: its rc.3 build
declares `Microsoft.EntityFrameworkCore.Relational >= 11.0.0-rc.3.26522.148`,
which conflicts with the same exact pin.
