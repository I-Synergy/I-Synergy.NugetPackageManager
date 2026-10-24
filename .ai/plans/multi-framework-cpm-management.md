# Plan: Multi-Framework CPM Version Management

**Status:** IMPLEMENTED (2026-10-24) — see `.ai/completed/multi-framework-cpm-management.md`
**Date:** 2026-10-24
**Scope:** this extension (`I-Synergy.NugetPackageManager`) + a usage playbook for `D:\Projects\I-Synergy\I-Synergy.Framework`

---

## 1. Context

### 1.1 Target scenario (verified against `D:\Projects\I-Synergy\I-Synergy.Framework`)

| Fact | Value |
|---|---|
| Projects | 102 `.csproj` |
| Projects that multi-target through a condition | 51 (`<TargetFrameworks>net10.0</TargetFrameworks>` + conditional append of `net11.0`) |
| CPM files | 1: `Directory.Packages.props` (145 lines) |
| Unconditional `PackageVersion` entries | 69 |
| Conditional groups | 2 × 31 packages, **identical package IDs** |
| Conditional group 1 | `Condition="!$(TargetFramework.StartsWith('net11.0'))"` → 10.0.13 line |
| Conditional group 2 | `Condition="$(TargetFramework.StartsWith('net11.0'))"` → 11.0.0-rc line |
| Overlap between groups | 31 / 31 |
| Overlap with unconditional group | 0 |
| Solution | `I-Synergy.Framework.slnx` (XML — already parsed by the extension) |
| SDK | `global.json` pins `11.0.100-rc.2.26504.105`, `allowPrerelease: true` |
| NuGet config | `nuget.config` with `packageSourceMapping` (Aspire → dotnet9 feed) |
| MSBuild evaluation | `dotnet msbuild src/.../Core.csproj -getProperty:TargetFrameworks` returns `net10.0;net11.0` (~4.7 s cold) |

The same source project therefore restores **different package versions per TFM**. This is the scenario the current framework-aware feature does not handle.

### 1.2 Current behaviour (verified by running the real `CpmResolver` against a copy of the framework file)

What works:
- `Directory.Packages.props` discovery (walk-up) and `ManagePackageVersionsCentrally` detection.
- Parsing all `ItemGroup`s: 69 unconditional + 2 × 31 conditional.
- Condition-scoped writes: updating a package through either group's `Condition` changes only that group.

What breaks:
1. **Both groups get the label `net11.0`.** `parseCpmConditionLabel` (`cpm-resolver.ts:304`) ignores `!`. The UI deduplicates options by label (`updates-view.ts:101`, `packages-view.ts:885`), so only one `net11.0` filter option exists.
2. **First-match attribution.** `getProjects`, `getOutdatedPackages`, and `getInconsistentPackages` use `conditional.find(e => e.versions.has(pkg.Id))` (`host-api.ts:177`, `:566`, `:730`). Because the IDs are in both groups, every package is attributed to group 1; group 2 never reaches the Updates list and can never be updated from the UI.
3. **Installed versions collapse to the first group.** `buildFlatCpmMap` (`host-api.ts:82`) takes the first conditional group, so Installed/Updates show 10.0.13 even for net11.0 projects.
4. **Tabs disagree.** `GetPackageVersionsAsync` (`cpm-resolver.ts:218`) is last-wins, so Vulnerabilities and the batch-update CPM check see 11.0.0-rc while Installed sees 10.0.13.
5. **No TFM evaluation.** `TargetFramework` appears only in a comment in `src/`; conditions are opaque labels.
6. **Global update touches one occurrence only.** `UpdatePackageVersionAsync` without `condition` uses a non-global regex; `consolidatePackagesAsync` (`host-api.ts:970`) updates group 1 only.
7. **`packageSourceMapping` is ignored.** `nuget-config-resolver.ts` parses sources but not the mapping, and `getLatestVersion` queries every source.
8. **Shared-file writes are repeated.** A batch update over 51 projects writes the same props file 51 times (mutex-protected, but redundant).

### 1.3 Goals

- **G1** — Resolve CPM versions **per project × target framework**, for arbitrary MSBuild TFM conditions, not just distinct `net8.0`/`net9.0` labels.
- **G2** — Show and update each version line independently (e.g. net10.0 → 10.0.x, net11.0 → 11.0.0-rc.x) without cross-contamination.
- **G3** — Recommend versions that are appropriate for the selected TFM (major-line alignment) while still allowing an explicit overall-latest bump.
- **G4** — Make Installed / Updates / Consolidate / Vulnerabilities agree on the same resolved version.
- **G5** — Keep the existing experience for regular (non-CPM, single-TFM) repositories unchanged.
- **G6** — Improve general NuGet handling: source mapping, prerelease semantics, discovery exclusions, caching, fewer network calls.

### 1.4 Non-goals (v1)

- Nested/imported `Directory.Packages.props` chains (`<Import Project=...>`).
- Conditional `PackageReference` items inside projects (none in the target repo).
- Replacing NuGet's own restore/audit engine; the extension remains a UI over `dotnet` + the NuGet API.

---

## 2. Design

### 2.1 Core model

Keep `CpmPackageMap` for compatibility, add a resolved model:

```ts
// src/common/types.d.ts (additive)
type CpmGroupRef = {
  condition: string;          // raw Condition, "" for unconditional
  conditionLabel: string;     // human label, disambiguated, e.g. "not net11.0"
  order: number;              // document order (MSBuild last-wins)
  isUnconditional: boolean;
};

type CpmVersionResolution = {
  PackageId: string;
  Tfm: string;                // "net10.0"
  Version: string;
  Condition: string;          // group that supplied it
  ConditionLabel: string;
};

type ProjectPackage = {
  // existing fields ...
  CpmResolutions?: CpmVersionResolution[];  // one entry per applicable TFM
};
```

`CpmFramework` stays on `OutdatedPackage` / `InconsistentPackage` / views for backward compatibility, but is populated with a **disambiguated label** and paired with a new `CpmTfm` field. Both are sent over RPC; no wire-breaking changes.

### 2.2 Condition evaluation

New pure module `src/host/utilities/cpm-condition.ts`:

```ts
type ConditionResult = "match" | "no-match" | "unknown";
parse(condition): CpmConditionAst;
evaluate(ast, props: { TargetFramework: string }): ConditionResult;
label(ast): string; // "net10.0", "not net11.0", or raw condition
```

Supported grammar (covers real-world CPM files, including this repo):

```
expr        := term (('And' | 'Or') term)*
term        := '!' term | '(' expr ')' | comparison | method-call
comparison  := '$(Prop)' ('==' | '!=') '<literal>'
method-call := '$(TargetFramework.StartsWith|EndsWith|Contains('<literal>'))'
```

Rules:
- `net10.0-windows10.0.26100.0` must still match `StartsWith('net10.0')`; do not string-equal TFMs.
- Anything unparsable → `unknown`. Unknown groups are still displayed and updatable by raw condition, but are **never** silently attributed to a TFM (no more `find` first-match).
- Labels disambiguate negation: `!$(TargetFramework.StartsWith('net11.0'))` → `not net11.0`; combined with the positive group the dropdown shows `net10.0` (from project TFMs) and `net11.0`, not two identical labels.
- Unit-test table: positive, negated, `==`, `!=`, `And`/`Or`, parentheses, platform suffixes, properties other than `TargetFramework`, malformed input.

### 2.3 TFM discovery

New `src/host/utilities/project-framework-resolver.ts`:

1. **Fast path:** if the nearest CPM file has no conditional groups, skip discovery entirely.
2. **Authoritative path:** `dotnet msbuild <project> -getProperty:TargetFramework -getProperty:TargetFrameworks -nologo` (JSON output; supported by the pinned SDK 11 and .NET 8+). This correctly evaluates the framework's `$([MSBuild]::VersionGreaterThanOrEquals('$(BundledNETCoreAppPackageVersion)','11.0'))` condition.
3. **Fallback:** parse literal `<TargetFramework(s)>` from XML when `dotnet` is missing, the SDK is wrong, or the command times out (60 s). Mark `TfmsSource: "fallback"` and surface a warning badge.
4. **Cache:** key = project path + mtime of the project and the nearest `Directory.Build.props` / `Directory.Build.targets` / `Directory.Packages.props` / `global.json`. Invalidate on any update. Run with concurrency 4 and show status-bar progress.
5. **Manual override:** setting `i-synergy-nugetpackagemanager.extraTargetFrameworks` (array) for projects whose TFMs cannot be evaluated.

### 2.4 Resolution rules (single source of truth)

Add one resolver method used by **all** host paths:

```ts
CpmResolver.ResolveAsync(projectPath, tfms): Promise<CpmPackageMap | null>
CpmResolver.ResolveVersion(cpmMap, packageId, tfm): CpmVersionResolution | null
```

Rules, matching MSBuild/NuGet semantics:
1. Evaluate every group condition against the TFM. Unconditional groups always apply.
2. If several groups contain the same package for that TFM, the **last in document order wins** (NuGet behaviour); retain provenance.
3. A package referenced by a project but absent for one of its TFMs is reported as "not restored for `netX`" instead of showing a wrong version.
4. Replace every `find(...)` first-match with `ResolveVersion`, and replace `buildFlatCpmMap` usage in read paths with per-TFM resolution. `ProjectParser` stays unchanged; the host decorates packages with `CpmResolutions`.

Consumers to update: `getProjectsAsync`, `getOutdatedPackagesAsync`, `getInconsistentPackagesAsync`, `getVulnerablePackagesAsync`, `batchUpdatePackagesAsync`, `consolidatePackagesAsync`.

### 2.5 Version recommendation policy

The framework's conditional lines are runtime-aligned (10.x for net10, 11.x for net11). The plugin must not suggest 11.0.0-rc for the net10 line.

- For each `(package, TFM)`, compute:
  - `latestCompatible`: highest version whose **major equals the TFM major** when the package matches an alignment pattern and the TFM is `net5.0+`.
  - `latestOverall`: current behaviour (highest across feeds, respecting the prerelease toggle).
- Defaults:
  - `i-synergy-nugetpackagemanager.frameworkAlignedPackages`: `["Microsoft.Extensions.*", "Microsoft.AspNetCore.*", "Microsoft.EntityFrameworkCore.*", "Microsoft.Maui.*", "System.*"]`.
  - `i-synergy-nugetpackagemanager.allowMajorBump`: `false`.
- UI shows `latestCompatible` as the primary action and `latestOverall` as a secondary action with a confirmation when it crosses a major line.
- Prerelease remains a global toggle (existing setting). For this repo it must be enabled so the net11 line can see 11.0.0-rc.*.

### 2.6 Write path

Replace per-project writes with a props-file-centric API:

```ts
UpdateCpmVersionsAsync(
  propsFilePath: string,
  changes: Array<{ packageId: string; version: string; condition?: string; scope: "group" | "all" }>
): Promise<void>
```

- Group changes **by props file**; one mutex per file; one read, apply all edits, one write, re-parse, verify each `(package, condition)`.
- `scope: "group"` writes inside exactly one `ItemGroup` (existing scoped regex, hardened for attribute order).
- `scope: "all"` updates every occurrence of the package (fixes consolidate; optional `g` flag semantics made explicit).
- Preserve comments, indentation, attribute order, and line endings (line-range replacement, not XML serialization).
- Batch update resolves `(packageId, condition) → propsFile` first, so 51 projects sharing one file produce **one write per package/group**, not 51.
- After all writes: one restore per affected project (existing `restoreProjectsAsync` / NU1605 handling), then reparse and report.
- Safety: workspace path validation (existing), per-group post-write verification, rollback by not writing if any change fails to locate its target.

### 2.7 UI

- **Framework selector** options are actual TFMs (`net10.0`, `net11.0`, plus `All`), derived from resolved projects, not from raw condition labels. Empty for single-TFM repos (unchanged behaviour).
- **Installed tab:** one row per `(Id, TFM)`; in `All` view show `Multiple` with a tooltip listing `net10.0: 10.0.13 / net11.0: 11.0.0-rc…`.
- **Updates tab:** one row per `(Id, TFM)` with TFM badge; bulk select scoped to the visible TFM; two actions: *Update selected for this TFM* and *Update all TFMs* (each TFM gets its `latestCompatible`).
- **Consolidate tab:** compare within `(Id, TFM)` only; cross-TFM differences are informational, not "inconsistent".
- **Vulnerabilities tab:** resolve per TFM, dedupe CVEs, show affected TFMs.
- **Warning badges:** `condition not evaluated` (unknown) and `package not restored for netX`.
- Components touched: `packages-view.ts`, `updates-view.ts`, `consolidate-view.ts`, `vulnerabilities-view.ts`, `package-row.ts`, `project-row.ts`, `search-bar.ts`.

### 2.8 General NuGet settings optimizations

| Area | Change |
|---|---|
| Source mapping | Parse `<packageSourceMapping>` in `nuget-config-resolver.ts` (merge across config chain, honour `<clear/>`); `getLatestVersion` queries only mapped sources for the package, falling back to all sources when no mapping exists |
| Redundant lookups | Cache latest version by `(packageId, prerelease)`; one network lookup per package even if it appears in two TFM groups |
| Discovery | Exclude `**/{bin,obj,TestResults,packages,.git}/**` from `findFiles`; add `i-synergy-nugetpackagemanager.excludeGlobs` |
| Solution scope | Already supports `.slnx`; add `workspaceContains:**/*.slnx` to `activationEvents` |
| Caching | Cache parsed projects and CPM maps keyed by mtime; invalidate after writes |
| Prerelease | Keep global toggle, but show for each TFM whether the installed version is prerelease and whether a stable update exists |
| Restore | Keep `skipRestore` default `false`; batch restore once after all group writes |
| Audit (optional) | `NuGetAuditMode=all` in the framework repo means transitive vulnerabilities matter; optionally add `dotnet list package --vulnerable --include-transitive` as a second source for the Vulnerabilities tab |

---

## 3. Execution phases

### Phase 0 — Safety net and fixture
- Add a trimmed fixture reproducing the framework shape (unconditional + negated group + positive group, same IDs, 3–4 packages per group) under `src/host/utilities/__fixtures__/`.
- Add characterization tests that pin today's behaviour (including the two known bugs) so the later changes are measurable.
- Add an opt-in integration test gated by `ISYNERGY_FRAMEWORK_PATH` that runs read-only resolution against the real repo.
- **Acceptance:** `npm test` green; fixture resolves to 2 groups with 31-ID overlap semantics.

### Phase 1 — Condition model and evaluator
- New `cpm-condition.ts` + tests; `CpmResolver` uses it for labels and evaluation.
- Remove negation-blind `parseCpmConditionLabel`.
- **Acceptance:** `!$(TargetFramework.StartsWith('net11.0'))` labels as `not net11.0`; `net10.0-windows…` matches `StartsWith('net10.0')`.

### Phase 2 — TFM discovery
- New `project-framework-resolver.ts` with `dotnet msbuild` evaluation, cache, timeout, XML fallback, concurrency limit, status bar.
- **Acceptance:** Core project resolves to `["net10.0","net11.0"]`; 102-project scan completes within the performance budget; missing `dotnet` falls back gracefully.

### Phase 3 — Host resolution matrix
- `ResolveAsync` / `ResolveVersion`; update all five read paths; additive RPC fields `CpmTfm`, `CpmResolutions`, `TfmsSource`.
- **Acceptance:** for `Microsoft.Extensions.Logging.Abstractions`, Installed/Updates/Vulnerabilities all report 10.0.13 for net10.0 and 11.0.0-rc.* for net11.0; no path uses `find` first-match or the flat map for read decisions.

### Phase 4 — Write path
- `UpdateCpmVersionsAsync`, group/all scopes, per-file batching and verification; migrate batch update and consolidate.
- **Acceptance:** updating the net11 row changes only lines in the second `ItemGroup`; updating the net10 row changes only the first; a 51-project batch writes the shared file once per `(package, group)`; formatting/comments preserved.

### Phase 5 — UI
- TFM-based selector, per-TFM rows, badges, actions, warnings, empty-state behaviour for single-TFM repos.
- **Acceptance:** framework dropdown shows `net10.0` and `net11.0` (no duplicate `net11.0`); selecting a TFM filters rows; "Update all TFMs" writes each group with its aligned version; non-CPM repo UI is unchanged.

### Phase 6 — General optimizations
- `packageSourceMapping`, latest-version cache, discovery exclusions, activation event, mtime caches.
- **Acceptance:** Aspire packages resolve only through the mapped feed; one NuGet lookup per package; `node_modules`-style exclusions no longer scan `obj/bin`; no regression in existing tests.

### Phase 7 — Validation, docs, release
- Run read/update scenarios against `I-Synergy.Framework` in an Extension Development Host (net10 + net11, batch, restore).
- Update README, CHANGELOG, settings docs; add a framework-repo usage section.
- **Acceptance:** manual checklist below passes; `npm run esbuild` and `npm run lint` are clean; a `.vsix` is built.

---

## 4. File-by-file change map

| File | Change |
|---|---|
| `src/host/utilities/cpm-condition.ts` | **new** — parser, evaluator, labels |
| `src/host/utilities/project-framework-resolver.ts` | **new** — TFM discovery, msbuild, cache, fallback |
| `src/host/utilities/cpm-resolver.ts` | group model, `ResolveAsync`/`ResolveVersion`, `UpdateCpmVersionsAsync`, scoped/all writes, verification |
| `src/host/host-api.ts` | replace first-match/flat-map read logic, dedupe writes and lookups, source-mapping-aware latest |
| `src/host/utilities/nuget-config-resolver.ts` | parse and expose `packageSourceMapping` |
| `src/host/utilities/nuget-api-factory.ts` / version lookup | mapping-aware source selection, latest cache |
| `src/common/rpc/types.ts` | additive `CpmTfm`, `CpmResolutions`, `TfmsSource`, update request scope |
| `src/common/types.d.ts` | resolution types |
| `src/web/components/packages-view.ts` | TFM selector and installed grouping |
| `src/web/components/updates-view.ts` | per-TFM rows, aligned latest, batch actions |
| `src/web/components/consolidate-view.ts` | TFM-scoped comparison |
| `src/web/components/vulnerabilities-view.ts` | per-TFM resolution |
| `src/web/components/package-row.ts`, `project-row.ts`, `search-bar.ts` | badges, TFM filter plumbing |
| `package.json` | new settings, `.slnx` activation |
| `src/host/utilities/cpm-resolver.test.ts` | condition/update tests |
| `src/host/utilities/cpm-condition.test.ts`, `project-framework-resolver.test.ts` | **new** tests |
| `README.md`, `CHANGELOG.md` | documentation |

---

## 5. Test plan

**Unit**
- Condition grammar table (positive/negative/comparison/And/Or/parens/platform suffix/unknown).
- Resolution: shared IDs across two groups, last-wins, TFM filtering, packages missing for a TFM.
- Writes: group scope, all scope, both attribute orders, comments/formatting preserved, post-write verification failure leaves file untouched.
- Version policy: net10 → 10.x, net11 → 11.x, non-aligned package → overall latest, prerelease.
- Source mapping: mapped package only queries mapped source; unmapped falls back to all.

**Integration / host**
- Temp workspace mimicking the framework layout: 2 projects, one multi-targeting `net10.0;net11.0`, shared props file, fixture content. Assert `getProjectsAsync`, `getOutdatedPackagesAsync`, `getInconsistentPackagesAsync`, `getVulnerablePackagesAsync`, `batchUpdatePackagesAsync`, `consolidatePackagesAsync`.
- Opt-in real-repo test (`ISYNERGY_FRAMEWORK_PATH`) for read-only resolution.

**Manual (Extension Development Host)**
1. Open `D:\Projects\I-Synergy\I-Synergy.Framework`; projects are discovered through `.slnx`.
2. Framework dropdown lists `net10.0` and `net11.0` exactly once each.
3. Installed shows Microsoft.Extensions.* at 10.0.13 for net10.0 and 11.0.0-rc.* for net11.0.
4. Updates lists both lines; updating the net11 line modifies only the second `ItemGroup`; git diff confirms.
5. Restore succeeds for a multi-target project; no NU1605 regression.
6. Batch "Update all TFMs" changes each group to its aligned latest.
7. Single-TFM/non-CPM sample repo shows the old UI and works unchanged.

**Performance budget**
- Warm 102-project load ≤ 10 s (excluding NuGet network lookups).
- One NuGet lookup per package ID per refresh.
- One props-file write per `(package, group)` per batch.

---

## 6. Usage playbook

### Regular (non-CPM / single-TFM) repos
- Keep `prerelease` off, `skipRestore` off, sources inherited from `nuget.config`.
- Use Installed → Updates → Consolidate → Vulnerabilities as today; no new UI appears.
- Prefer "Update all projects" for shared versions; use Consolidate for drift.

### I-Synergy Framework
Workspace `.vscode/settings.json` recommendation:

```jsonc
{
  "i-synergy-nugetpackagemanager.prerelease": true,          // net11 line is RC
  "i-synergy-nugetpackagemanager.skipRestore": false,        // restore validates both TFMs
  "i-synergy-nugetpackagemanager.statusBarLoadingIndicator": true,
  "i-synergy-nugetpackagemanager.frameworkAlignedPackages": [
    "Microsoft.Extensions.*", "Microsoft.AspNetCore.*",
    "Microsoft.EntityFrameworkCore.*", "Microsoft.Maui.*", "System.*"
  ]
}
```

Workflow:
1. Open the repo root; the extension scopes to `I-Synergy.Framework.slnx`.
2. Use the TFM filter: **net10.0** for the stable line, **net11.0** for the preview line.
3. Update the net11 line first (prerelease), then the net10 line; each write targets its own `ItemGroup`.
4. Use *Update all TFMs* for runtime-aligned families (Microsoft.Extensions.*, AspNetCore.*, EF Core).
5. Let restore run; keep NU1605 auto-resolution enabled.
6. Never consolidate across TFM lines — the two versions are intentional.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `dotnet msbuild` slow across 102 projects | Run only when conditional CPM groups exist; cache by mtime; concurrency 4; 60 s timeout |
| SDK/global.json mismatch breaks evaluation | XML fallback + warning badge + `extraTargetFrameworks` override |
| Unsupported MSBuild condition syntax | `unknown` result, raw condition shown, never auto-attributed |
| Regex write corrupts formatting | Line-range replacement inside the located `ItemGroup`, post-write reparse, no write on verification failure |
| Multiple matching groups for one TFM | Deterministic last-in-document-order rule (NuGet semantics), provenance surfaced in UI |
| Concurrent writes to a shared props file | Existing per-file mutex, extended to the multi-change API |
| Network rate limits (131 packages × sources) | Deduplicate lookups per package ID; existing batching kept |
| Behaviour drift for regular repos | Feature detection (conditional groups / multi-TFM); regression tests for non-CPM paths |

---

## 8. Decisions to confirm

1. **Major-line alignment default** — recommend `latestCompatible` first, `latestOverall` behind an explicit action. Confirm.
2. **"Update all TFMs" semantics** — each TFM receives its own aligned latest (not one version for all). Confirm.
3. **MSBuild evaluation cost** — accept a one-off cached `dotnet msbuild` pass for multi-target projects. Confirm.
4. **Scope of v1** — exclude nested/imported CPM files and conditional `PackageReference`s. Confirm.

---

## 9. Effort estimate

| Phase | Estimate |
|---|---|
| 0 — fixture + characterization | 0.5–1 day |
| 1 — condition evaluator | 1 day |
| 2 — TFM discovery | 1 day |
| 3 — host resolution | 2 days |
| 4 — write path | 1.5–2 days |
| 5 — UI | 2–3 days |
| 6 — general optimizations | 1–1.5 days |
| 7 — validation/docs | 1 day |
| **Total** | **~10–12.5 dev days** |

MVP cut (phases 0–5, items 1–2 of §8 confirmed) already makes the framework scenario usable; phase 6 is the general-purpose polish.

---

## 10. Approval checklist

- [ ] §8 decisions answered
- [ ] Phases 0–7 approved (or MVP cut selected)
- [ ] Progress file created at `.ai/progress/multi-framework-cpm-management.md`
- [ ] Implementation starts only after approval
