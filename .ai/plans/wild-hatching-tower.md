# Plan: Framework-Aware CPM Package Updates

## Context

`Directory.Packages.props` can have `<ItemGroup Condition="...">` blocks scoping packages
to a specific target framework (e.g. `$(TargetFramework.StartsWith('net8.0'))`).

Currently:
- `CpmResolver` reads all `PackageVersion` elements ignoring `Condition` — flat `Map<packageId→version>`
- `UpdatePackageVersionAsync` uses a global regex on the raw file, no condition scope
- `getOutdatedPackagesAsync` keys by `packageId` only — a net8.0 and net9.0 version of the same package are collapsed together
- The Updates UI has no framework concept at all

The goal: when a CPM file has framework-conditional groups, show a **framework filter dropdown** in the Updates tab, display packages grouped by framework, and update only within the correct `<ItemGroup>` block. When no conditional packages exist, the UI is identical to today.

---

## Step 1 — `cpm-resolver.ts`: new types, new method, condition-scoped update

**New exported types** (top of file):
```typescript
export type CpmFrameworkEntry = {
  condition: string;   // raw XML Condition value, e.g. "$(TargetFramework.StartsWith('net8.0'))"
  framework: string;   // parsed label, e.g. "net8.0"
  versions: Map<string, string>;
};
export type CpmPackageMap = {
  unconditional: Map<string, string>;
  conditional: CpmFrameworkEntry[];
};
```

**New private helper** `parseCpmConditionLabelAsync` (pure, no file I/O — name ends with `Async` not needed here, call it `parseCpmConditionLabel` as a private static non-async):
```typescript
private static parseCpmConditionLabel(condition: string): string {
  const m = condition.match(/(net\d+\.\d+(?:-\w+)?|netstandard\d+\.\d+|netcoreapp\d+\.\d+)/i);
  return m ? m[1]!.toLowerCase()
           : condition.replace(/[$()'"]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}
```

**New public method** `GetFrameworkPackageMapAsync(projectPath)`:
- Same null-guards as `GetPackageVersionsAsync` (finds CPM file, checks enabled)
- Calls new private `ParseFrameworkPackageMapAsync(cpmFilePath)`:
  - XPath: select `//ItemGroup` nodes (not `//ItemGroup/PackageVersion`)
  - For each node: read `Condition` attribute
    - No condition / empty → add children to `unconditional` map
    - Has condition → find-or-create `CpmFrameworkEntry`, populate its `versions`
  - Return `CpmPackageMap`

**Updated `UpdatePackageVersionAsync`** — add optional `condition?: string` param:
- When `condition` is `undefined`: existing behavior (global regex, no change to callers)
- When `condition` is provided: two-phase scoped replace
  1. Match the `<ItemGroup …Condition="<escaped>"…>…</ItemGroup>` block with a `s` (dotAll) regex
  2. Run the existing Include/Version regex **only on that block**'s content
  3. Splice the updated block back into the full string
  4. Throw if ItemGroup block not found, or if package not found within it

---

## Step 2 — `src/common/rpc/types.ts`: add optional fields

**`OutdatedPackage`** — add two optional fields:
```typescript
CpmCondition?: string;   // raw XML Condition; absent = unconditional
CpmFramework?: string;   // parsed label e.g. "net8.0"; absent = unconditional
```

**`BatchUpdateRequest.Updates` array element** — add optional field:
```typescript
CpmCondition?: string;
```

---

## Step 3 — `host-api.ts`: `getOutdatedPackagesAsync`

Replace the existing `GetPackageVersionsAsync` call (used for parsing only) with `GetFrameworkPackageMapAsync`. Keep `GetPackageVersionsAsync` for the `isCpm` check and `UpdatePackageVersion` path.

Change `installedMap` key from `packageId` to `"${packageId}\0${condition}"` (null-byte composite).
Change value type to include `condition` and `framework` strings.

For each package in each project:
1. If project has a `CpmPackageMap`:
   - Look up `pkg.Id` in `unconditional` → condition `""`
   - If not there, scan `conditional` entries → use matching entry's `condition`/`framework`
2. Else (non-CPM): condition `""`, framework `""`

The `outdated.push(...)` call gains:
```typescript
CpmCondition: installed.condition || undefined,
CpmFramework: installed.framework || undefined,
```

Cache `CpmPackageMap` results by project path in a local `Map` within the function to avoid re-reading the same `Directory.Packages.props` for each project in the solution.

---

## Step 4 — `host-api.ts`: `batchUpdatePackagesAsync`

In the CPM branch, forward `CpmCondition` to the resolver:
```typescript
await CpmResolver.UpdatePackageVersionAsync(
  projectPath, update.PackageId, update.Version, update.CpmCondition
);
```
No other logic changes.

---

## Step 5 — `src/web/types.ts`: `OutdatedPackageViewModel`

Add two fields:
```typescript
CpmCondition: string;  // "" if unconditional
CpmFramework: string;  // "" if unconditional
```
Set from `model.CpmCondition ?? ""` and `model.CpmFramework ?? ""` in the constructor.

---

## Step 6 — `updates-view.ts`: framework selector + filtered display

**New `@state()`:**
```typescript
@state() private _selectedFramework = "";  // "" = "All"
```

**New computed getter `frameworkOptions`:**
```typescript
private get frameworkOptions(): Array<{ value: string; label: string }> {
  const frameworks = new Set(this.packages.map(p => p.CpmFramework).filter(Boolean));
  if (frameworks.size === 0) return [];
  return [
    { value: "", label: "All frameworks" },
    ...[...frameworks].sort().map(f => ({ value: f, label: f })),
  ];
}
```
Returns empty → no selector shown → existing UI unchanged (backward compat).

**Updated `visiblePackages` getter:**
```typescript
private get visiblePackages(): OutdatedPackageViewModel[] {
  let list = this.packages;
  if (this._selectedFramework !== "" && this.frameworkOptions.length > 0) {
    list = list.filter(p => p.CpmFramework === this._selectedFramework || p.CpmFramework === "");
  }
  if (!this.filterQuery) return list;
  const q = this.filterQuery.toLowerCase();
  return list.filter(p => p.Id.toLowerCase().includes(q));
}
```
When "All frameworks" is selected (value `""`): no framework filter, show everything.
When a specific framework is selected: show that framework's packages + unconditional packages.

**Updated `allVisibleSelected` / `toggleSelectAll`:** operate on `visiblePackages` (not all packages) so select-all respects the current filter.

**Framework selector in toolbar** (shown only when `frameworkOptions.length > 0`, placed before `toolbar-right`):
```html
<select .value=${this._selectedFramework}
        @change=${(e) => { this._selectedFramework = (e.target as HTMLSelectElement).value; }}>
  ${this.frameworkOptions.map(o => html`<option value=${o.value}>${o.label}</option>`)}
</select>
```

**Framework badge on each package row** (shown only when "All" is active and package has a framework):
```html
${pkg.CpmFramework && !this._selectedFramework
  ? html`<span class="framework-badge">${pkg.CpmFramework}</span>`
  : nothing}
```
Add minimal CSS: `framework-badge` — small pill with `vscode-badge`-style colors.

**Pass `CpmCondition` in update calls** — both `updateSingleAsync` and `updateAllSelectedAsync`:
```typescript
{ PackageId: pkg.Id, Version: pkg.LatestVersion,
  ProjectPaths: pkg.Projects.map(p => p.Path),
  CpmCondition: pkg.CpmCondition || undefined }
```

**Reset `_selectedFramework = ""` in `LoadOutdatedPackagesAsync`** before clearing packages.

---

## Step 7 — Tests

**`cpm-resolver.test.ts`** — new suite:
- `GetFrameworkPackageMapAsync` returns null for no CPM / disabled CPM
- Returns only `unconditional` entries when no `Condition` attributes exist (matches existing flat behavior)
- Correctly separates conditional from unconditional entries for a mixed CPM file
- `parseCpmConditionLabel` tested indirectly: `framework` field in returned `CpmFrameworkEntry`
- `UpdatePackageVersionAsync` with condition: scoped to matching ItemGroup, does not touch other groups
- `UpdatePackageVersionAsync` with condition: throws when package not in that group
- `UpdatePackageVersionAsync` without condition: existing tests unchanged

**`host-api.test.ts`** — new cases:
- `getOutdatedPackages` sets `CpmCondition`/`CpmFramework` for conditional packages
- `getOutdatedPackages` omits both fields for unconditional packages
- `batchUpdatePackages` forwards `CpmCondition` to `UpdatePackageVersionAsync`

---

## Critical Files

| File | Change |
|------|--------|
| `src/host/utilities/cpm-resolver.ts` | New types, new `GetFrameworkPackageMapAsync`, updated `UpdatePackageVersionAsync` |
| `src/common/rpc/types.ts` | Add optional `CpmCondition`/`CpmFramework` to `OutdatedPackage`; `CpmCondition` to `BatchUpdateRequest.Updates` |
| `src/host/host-api.ts` | `getOutdatedPackagesAsync` (composite key, framework map) + `batchUpdatePackagesAsync` (forward condition) |
| `src/web/types.ts` | `OutdatedPackageViewModel` — add `CpmCondition`/`CpmFramework` fields |
| `src/web/components/updates-view.ts` | `_selectedFramework` state, `frameworkOptions`, updated `visiblePackages`, selector UI, badge, updated update calls |
| `src/host/utilities/cpm-resolver.test.ts` | New framework-aware tests |
| `src/host/host-api.test.ts` | New host-api tests for framework flow |

---

## Verification

1. `npm run esbuild` — clean build
2. `npm test` — all 217 existing tests pass + new tests pass
3. `npm run lint` — no new lint errors
4. Manual: open a workspace with a `Directory.Packages.props` that has framework-conditional ItemGroups → Updates tab shows framework dropdown
5. Manual: workspace with no conditional CPM → Updates tab looks identical to today
