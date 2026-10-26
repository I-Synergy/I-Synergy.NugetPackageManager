# Rename to TheNugetPackageManager + faster Updates

Status: DONE
Started: 2026-10-26
Completed: 2026-10-26
Plan: `.ai/plans/rename-and-faster-updates.md`

## Steps

### Phase 0 — Rename identity and identifiers
- [x] Add `src/common/configuration.ts` (new namespace + legacy fallback + migration) with tests
- [x] Update `package.json` name/displayName/commands/panel/views/settings (new + deprecated legacy keys)
- [x] Update code IDs: extension, logger, host-api, utilities, webview element, tools
- [x] Update CI, docs, README, CHANGELOG, `.ai` context
- [x] Add manifest regression test
- [x] Verify: esbuild, lint, test-compile, test, package, manifest inspection

### Phase 1 — Warm start: persisted scan + stale-while-revalidate
- [x] Host scan cache (workspaceState) + `PreferCache` RPC
- [x] Updates view paints cached rows first, preserves selection, refreshes live
- [x] Tests (host + component)

### Phase 2 — Fewer requests and HTTP cache
- [x] Reuse dependency groups embedded in registration data
- [x] Disk HTTP cache (30 min TTL, global storage) + Force Reload clears it
- [x] Configurable latest-check concurrency (`updateCheckConcurrency`, default 8)
- [x] Tests

### Phase 3 — Persisted TFM resolution (optional, deferred)
- [ ] Persist resolver results keyed by mtime fingerprint

Deferred: the current workspace resolves 86 projects from literal XML and 16
from `project.assets.json`, so MSBuild is never invoked. Persisting TFM results
only helps an unrestored tree; it can be added without changing the resolver's
public shape.

## Verification

- `npm test` — 388 passing
- `npm run lint` — clean
- `npm run esbuild` — clean
- `npm run package` — `releases/thenugetpackagemanager-1.2.14.vsix`
- VSIX manifest: `thenugetpackagemanager` / `TheNugetPackageManager` /
  `I-Synergy`, 6 new command IDs, 24 configuration entries (12 new + 12
  deprecated legacy).

## Notes

- Marketplace sees a new extension ID; the old listing needs a deprecation
  notice/redirect. Existing installs do not auto-update.
- The legacy settings namespace and `nugetpackage.*` command aliases were removed
  completely; no compatibility shims remain.
- No legacy command aliases, panel serializer or activation events remain.
- View container ID changed, so Activity Bar placement resets once.
- Screenshots still show the old title until `npm run docs` is run (it installs
  Playwright/Chromium and adds dev dependencies).
- Unrelated uncommitted work from the NU1107/conflict-visibility session remains
  in the working tree; no commit was created for either change set.
