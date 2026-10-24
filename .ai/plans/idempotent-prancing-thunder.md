# Plan: Rename All Async Methods to End with `Async`

## Context

C# convention: all async methods end in `Async`. The user wants this enforced in TypeScript too. 63 methods across the codebase need renaming. The `HostAPI` interface drives the RPC wire protocol (method names sent as strings over `postMessage`), so renaming it cascades to both the host implementation and all webview call sites.

---

## Execution Order

Rename bottom-up: interface → implementations → call sites → tests.

---

## File-by-File Rename Map

### 1. `src/common/rpc/types.ts` — HostAPI interface
Rename 16 interface method signatures:
- `getProjects` → `getProjectsAsync`
- `getPackages` → `getPackagesAsync`
- `getPackage` → `getPackageAsync`
- `getPackageDetails` → `getPackageDetailsAsync`
- `updateProject` → `updateProjectAsync`
- `getConfiguration` → `getConfigurationAsync`
- `updateConfiguration` → `updateConfigurationAsync`
- `openUrl` → `openUrlAsync`
- `updateStatusBar` → `updateStatusBarAsync`
- `getOutdatedPackages` → `getOutdatedPackagesAsync`
- `batchUpdatePackages` → `batchUpdatePackagesAsync`
- `getInconsistentPackages` → `getInconsistentPackagesAsync`
- `getVulnerablePackages` → `getVulnerablePackagesAsync`
- `showConfirmation` → `showConfirmationAsync`
- `getOperationProgress` → `getOperationProgressAsync`
- `consolidatePackages` → `consolidatePackagesAsync`

### 2. `src/host/host-api.ts` — Host-side RPC implementation
Same 16 renames as above (method names must match interface).

### 3. `src/common/rpc/rpc-host.ts`
- `handleMessage` → `handleMessageAsync`

### 4. `src/host/nuget/api.ts` — Private methods only (public already end in Async)
- `EnsureSearchUrl` → `EnsureSearchUrlAsync`
- `GetUrlFromNugetDefinition` → `GetUrlFromNugetDefinitionAsync`
- `ExecuteGet` → `ExecuteGetAsync`

### 5. `src/host/nuget/api-factory.ts`
- `GetSourceApi` → `GetSourceApiAsync`

### 6. `src/host/utilities/task-executor.ts`
- `ExecuteCommand` → `ExecuteCommandAsync`

### 7. `src/host/utilities/project-parser.ts`
- `Parse` → `ParseAsync`

### 8. `src/host/utilities/password-script-executor.ts`
- `ExecuteScript` → `ExecuteScriptAsync`
- `executeScriptInternal` → `executeScriptInternalAsync`

### 9. `src/host/utilities/nuget-config-resolver.ts`
- `GetSourcesAndDecodePasswords` → `GetSourcesAndDecodePasswordsAsync`
- `GetSourcesWithCredentials` → `GetSourcesWithCredentialsAsync`
- `ParseConfigFile` → `ParseConfigFileAsync`

### 10. `src/host/utilities/cpm-resolver.ts`
- `GetPackageVersions` → `GetPackageVersionsAsync`
- `FindDirectoryPackagesPropsFile` → `FindDirectoryPackagesPropsFileAsync`
- `IsCentralPackageManagementEnabled` → `IsCentralPackageManagementEnabledAsync`
- `UpdatePackageVersion` → `UpdatePackageVersionAsync`
- `ParsePackageVersions` → `ParsePackageVersionsAsync`

### 11. `src/host/utilities/package-version-decorator.ts`
- `updateDecorations` → `updateDecorationsAsync`
- `fetchAndDecorate` → `fetchAndDecorateAsync`

### 12. `src/web/configuration.ts`
- `Reload` → `ReloadAsync`

### 13. `src/web/components/packages-view.ts` — Own method renames
- `toggleProjectTree` → `toggleProjectTreeAsync`
- `handleTabKeydown` → `handleTabKeydownAsync`
- `setTab` → `setTabAsync`
- `onChildPackageSelected` → `onChildPackageSelectedAsync`
- `setSearchQuery` → `setSearchQueryAsync`
- `OnProjectSelectionChanged` → `OnProjectSelectionChangedAsync`
- `reloadChildViews` → `reloadChildViewsAsync`
- `LoadProjectsPackages` → `LoadProjectsPackagesAsync`
- `OnProjectUpdated` → `OnProjectUpdatedAsync`
- `UpdatePackage` → `UpdatePackageAsync`
- `UpdatePackagesFilters` → `UpdatePackagesFiltersAsync`
- `SelectPackage` → `SelectPackageAsync`
- `PackagesScrollEvent` → `PackagesScrollEventAsync`
- `ReloadInvoked` → `ReloadInvokedAsync`
- `LoadPackages` → `LoadPackagesAsync`
- `LoadProjects` → `LoadProjectsAsync`
- Also update all `hostApi.xxx()` call sites to `hostApi.xxxAsync()`

### 14. `src/web/components/updates-view.ts`
- `LoadOutdatedPackages` → `LoadOutdatedPackagesAsync`
- `updateSingle` → `updateSingleAsync`
- `updateAllSelected` → `updateAllSelectedAsync`
- Update `hostApi.xxx()` call sites

### 15. `src/web/components/consolidate-view.ts`
- `LoadInconsistentPackages` → `LoadInconsistentPackagesAsync`
- `consolidateSingle` → `consolidateSingleAsync`
- `consolidateAll` → `consolidateAllAsync`
- Update `hostApi.xxx()` call sites

### 16. `src/web/components/vulnerabilities-view.ts`
- `LoadVulnerablePackages` → `LoadVulnerablePackagesAsync`
- Update `hostApi.xxx()` call sites

### 17. `src/web/components/search-bar.ts`
- `prereleaseChangedEvent` → `prereleaseChangedEventAsync`
- `savePrereleaseToConfiguration` → `savePrereleaseToConfigurationAsync`
- Update `hostApi.xxx()` call sites
- Update template event handler reference

### 18. `src/web/components/settings-view.ts`
- `updateConfiguration` → `updateConfigurationAsync`
- `removeRow` → `removeRowAsync`
- Update `hostApi.xxx()` call sites and template references

### 19. `src/web/components/project-row.ts`
- `update_` → `update_Async`
- Update `hostApi.xxx()` call sites and template references

### 20. Other web components — hostApi call site updates only
Any remaining component that calls `hostApi.xxx()` needs the call site updated.

### 21. Test files
Update every test that calls async methods by their old names:
- `packages-view.test.ts` — 8+ method call sites
- `search-bar.test.ts` — 0 direct async method calls (no changes)
- `package-details.test.ts` — 0 direct async method calls (no changes)
- Host test files (`host-api.test.ts`, `task-executor.test.ts`, `project-parser.test.ts`, etc.) — update call sites

---

## Verification

1. `npm run esbuild` — no TypeScript errors
2. `npm run lint` — no new lint violations
3. `npm test` — all 206 tests pass
