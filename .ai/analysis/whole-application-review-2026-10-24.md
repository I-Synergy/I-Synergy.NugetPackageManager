# Whole-Application Review — NuGet Package Manager

**Date:** 2026-10-24
**Status:** COMPLETE (review only — no code changed)
**Method:** four parallel read-only reviewers (architecture/correctness, security, web UI, tests/maintainability) plus direct verification of every Blocker and the highest-impact Major findings against the working tree.
**Current checks:** `tsc -p tsconfig.test.json` clean, `eslint src` clean, **277 tests passing**.

---

## Executive summary

The application is well structured for a VS Code extension of this size: the host/web split is clean, the RPC layer is typed, the CPM/condition code is unusually well tested, and the code avoids the classic webview XSS and shell-injection traps.

The risks are concentrated in four areas:

1. **Trust boundary** — a workspace can make the extension execute a script and expand process-environment secrets into credentials sent to a workspace-declared feed.
2. **CPM write scoping** — an unconditional package row is sent to the host with `Scope: "all"`, which can overwrite framework-scoped version lines; the post-write verifier then confirms the corrupted state.
3. **Path validation** — the only workspace-containment check is a string `startsWith` on slash-normalised paths; it rejects every path on Linux/macOS and can be bypassed on Windows. The write RPCs do not check at all.
4. **Verification gaps** — 11 of 18 host RPC methods, the RPC transport, and all four feature tabs in the webview have no tests. The write paths are exactly where the above defects live.

**Recommended release gate:** fix the four Blockers and the CPM/consolidation write-path Majors before publishing. The packaging and CI Majors should also be fixed before the next release, because the current `.vsix` would ship 12 MB of agent notes and the publish job is not release-gated.

| Severity | Count |
|---|---:|
| Blocker | 4 |
| Major | 16 |
| Minor | 20 |

---

## Findings

| ID | Severity | Area | Location | Finding |
|---|---|---|---|---|
| B1 | Blocker | Security / trust | `package.json:127-138`, `src/host/utilities/nuget-config-resolver.ts:74-93`, `src/host/utilities/password-script-executor.ts:26-51` | A workspace `.vscode/settings.json` can set `passwordScriptPath` (the `sources` setting has no `"scope": "machine"`). It is executed with `powershell -ExecutionPolicy Bypass -File`, `cmd /c`, or `sh`, with no trust check, no containment, no signature check, and no prompt. Confirm: no `capabilities.untrustedWorkspaces` in `package.json` and no `isTrusted` check in `src/`. |
| B2 | Blocker | CPM correctness | `src/web/components/updates-view.ts:158`, `src/host/host-api.ts:840-864`, `src/host/utilities/cpm-resolver.ts:337-342` | An unconditional update row sends `Scope: "all"`; the host keeps it (`scope = scope ?? "first"` does not override an explicit value) and `replaceInElements(..., global=true)` rewrites **every** occurrence of that package, including conditional framework lines. `verifyChanges` then passes because all occurrences match. Reproducible with `__fixtures__/cpm/unconditional-plus-conditional.props`. |
| B3 | Blocker | Security / compatibility | `src/host/host-api.ts:471-475` | `updateProjectAsync` does `request.ProjectPath.replace(/\//g, "\\")` then `startsWith(root)`. On Linux/macOS every install/update/uninstall fails; on Windows `<root>-evil\x.csproj` and `<root>\..\..\x.csproj` pass. `batchUpdatePackagesAsync`, `consolidatePackagesAsync`, `restoreProjectsAsync` have no containment check at all. |
| B4 | Blocker | Security / secrets | `src/host/utilities/nuget-config-resolver.ts:355-358`, `src/host/nuget/api-factory.ts:24` | Workspace `nuget.config` credentials are expanded with `%VAR%` → `process.env[VAR]`. A repo can declare an attacker feed and `ClearTextPassword="%GITHUB_TOKEN%"`; the value is then sent as Basic auth to that feed on the first request. |
| M1 | Major | CPM / UI | `src/web/components/consolidate-view.ts:188-206`, `:197` | `consolidatePackagesAsync` is awaited but its `Result` is never inspected; failure is reported as success. It then removes **all** rows with the same `Id`, including other framework lines, and sends `Scope: "all"` for unconditional rows (same corruption as B2). |
| M2 | Major | Reliability | `src/common/rpc/rpc-client.ts:53-56`, `src/common/rpc/rpc-host.ts:24-58`, `src/host/utilities/task-executor.ts:21-85` | The 120 s RPC timeout resolves `fail(...)` without posting `rpc-cancel`; the host never aborts the dotnet process. Long batch/consolidate/restore operations continue writing after the UI reports failure. `TaskExecutor` also has no cancellation or process timeout, so a hung dotnet process holds the global mutex forever. |
| M3 | Major | CPM correctness | `src/web/components/project-row.ts:68-74`, `src/host/host-api.ts:500-521` | The per-project update request carries no `CpmCondition`/`CpmTfm`. For a package present in several conditional groups the host picks the first occurrence (or the single group), so updating from the details pane can rewrite the wrong framework line. |
| M4 | Major | CPM correctness | `src/host/utilities/cpm-resolver.ts:562-607` | Only `ItemGroup[@Condition]` is read. A condition on the `PackageVersion` element itself is ignored and the entry is treated as unconditional (or overwritten by document order). |
| M5 | Major | Security / data | `src/host/utilities/cpm-resolver.ts:368-378`, write at `:278` | `packageId` and `newVersion` are interpolated into an XML attribute without validation or escaping. A hostile feed can return a version containing `"`/`<`/`>` and inject elements into `Directory.Packages.props`; the verifier re-parses the injected document. |
| M6 | Major | Correctness | `src/host/host-api.ts:1105-1152`, `src/host/nuget/api.ts:357` | Installed packages are keyed by lowercase id but feed vulnerability keys are used verbatim; `Map.get` is case-sensitive. A casing mismatch silently drops CVEs. A failed page fetch still caches the partial map for one hour, producing false negatives. |
| M7 | Major | Correctness | `src/host/nuget/api.ts:181-198` | The “latest” version is taken as the **last registration item** with no SemVer sort. Correctness depends on feed ordering; an out-of-order page yields a wrong latest version and disagrees with the Updates tab. |
| M8 | Major | Security | `src/host/nuget/api.ts:82-92`, `:150`, `:248`, `:272-284` | The Basic-auth interceptor is attached to the whole axios instance, which is also used for feed-supplied registration/catalog URLs and caller-supplied `PackageVersionUrl`. A hostile feed receives the configured credentials. |
| M9 | Major | Packaging | `.vscodeignore` | `.ai/**` and `AGENTS.md` are not excluded. `.ai/` is **12 MB** of agent skills, plans and internal notes; `vsce package` ships it. |
| M10 | Major | Release | `.github/workflows/ci.yml:47-51,72-85` | The publish job runs on every push to `main`, unconditionally publishes, then creates a tag without checking whether it exists. A non-release commit fails at publish; a re-run fails at `git tag`. |
| M11 | Major | Tests | `src/host/host-api.ts`, `src/common/rpc/*`, `src/web/components/{updates,consolidate,vulnerabilities,settings}-view.ts`, `project-tree.ts` | 11 of 18 host RPC methods have no tests, including every write path; the RPC transport and all four feature tabs have none. See the coverage map below. |
| M12 | Major | Developer workflow | `package.json:208-211`, `README.md:369-370` | No `pretest`; `.vscode-test.js` collects `out/**/*.test.js`, so `npm test` on a clean clone finds no tests. README calls `test-compile` a type-check, but it emits. Only CI gets the order right. |
| M13 | Major | Performance | `src/web/components/packages-view.ts:1188-1224` | All five tab panels are always mounted; `hidden` only hides them. Installed, Updates, Consolidate and Vulnerabilities each start their scan on mount, so a 100+ project workspace pays every scan on startup. |
| M14 | Major | UX / reliability | `src/web/components/project-row.ts:80-100` | If `updateProjectAsync` returns `fail`, no error is shown and the row silently keeps its old state. |
| M15 | Major | Reliability | `src/host/utilities/task-executor.ts:21-85` | No timeout and no abort signal for spawned dotnet processes. A process that never exits leaves `globalMutex` held and blocks every later operation. |
| M16 | Major | UI correctness | `src/web/components/packages-view.ts:810-822`, `src/web/components/search-bar.ts:88,194`, `src/common/rpc/types.ts` | The Sort dropdown updates `filters.Sort` and refetches, but `GetPackagesRequest` has no `Sort` field and `buildRequest()` never sends it. The control is inert; sorting is whatever the feed returns. |
| m1 | Minor | Maintainability | `src/host/utilities/credentials-cache.ts`, `src/host/utilities/nuget-config-resolver.ts:85-92` | The decoded-password cache is write-only: only `set()` and `clear()` are called; `get()`, `has()`, `clearExpired()` have no callers. Dead code and retained secrets. |
| m2 | Minor | Reliability | `src/host/utilities/package-version-decorator.ts:211-214` | `dispose()` does not clear the 500 ms debounce timer; the callback can run after the decoration type is disposed. README also claims decorations are clickable, but the decoration has no command. |
| m3 | Minor | Maintainability | `package.json:107-125` | `defaultSource`, `pageSize` and `showOutputOnError` are contributed settings with no readers in `src/`. |
| m4 | Minor | Dependencies | `package.json:250-251` vs `src/common/logger.ts:5-13`; `package.json:257` | `@opentelemetry/sdk-trace-base`, `resources` and `semantic-conventions` are imported but not declared; resolution relies on hoisting. `object-hash` is declared but unused. |
| m5 | Minor | Security | `src/host/host-api.ts:615-618` | `openUrlAsync` calls `openExternal` with no scheme allowlist; URLs come from feed data (advisory, license, project URLs). |
| m6 | Minor | Security | `src/host/extension.ts:172-190` | CSP is only `script-src 'nonce-…'`; no `default-src`, `img-src`, `connect-src`, `base-uri`, `form-action`. No HTML-injection sink was found, so this is defence-in-depth. |
| m7 | Minor | Privacy | `src/common/logger.ts:41-66` | Telemetry is gated by `vscode.env.isTelemetryEnabled`, but resource attributes include `machineId`, `sessionId`, shell/remote details and log text containing workspace paths and usernames. |
| m8 | Minor | Data safety | `src/host/utilities/cpm-resolver.ts:270-278` | Read-modify-`writeFile` is not atomic; an external editor or crash can be overwritten/truncated despite the in-process mutex. |
| m9 | Minor | Security | `src/host/nuget/api-factory.ts:12-33` | `_sourceApiCollection` is a plain object used with `in` and index assignment; source URLs such as `"constructor"`/`"__proto__"` hit the prototype chain. Use `Map`. |
| m10 | Minor | Security | `src/host/nuget/api.ts:86` | Basic auth is attached only when **both** username and password are non-empty; token-only feeds with an empty username never authenticate. |
| m11 | Minor | CPM correctness | `src/host/utilities/cpm-resolver.ts:574-602` | When the same `Condition` appears in several `ItemGroup`s, the entry keeps the first group's `order` while later groups overwrite its versions, so document-order precedence can be wrong in that edge case. |
| m12 | Minor | Tests | `src/host/utilities/project-framework-resolver.ts:49-52,228-277` | No test covers cache-key invalidation on file change, the cache-size clear, or the concurrency gate. `SetEvaluatorForTests`/`ClearCache` are production APIs used only by tests. |
| m13 | Minor | Tests | `src/host/utilities/nuget-config-resolver.test.ts:164-181` | Home-directory assertions are wrapped in `if (os.homedir() === homeDir)`, so on Windows they can pass without asserting anything. Teardown replaces the whole `process.env` object. |
| m14 | Minor | Tests | `src/host/nuget/api-factory.test.ts:51-146` | Six tests assert only on `Logger.*` calls, not on the returned API or credentials. |
| m15 | Minor | Tests | `src/web/components/project-row.test.ts:130,160`, `search-bar.test.ts:106`, `password-script-executor.test.ts:74-232` | Fixed `setTimeout` waits and a real 600 ms debounce wait make these tests timing-sensitive. |
| m16 | Minor | Accessibility | `src/web/components/dropdown.ts`, `project-row.ts`, `nuget-license-dialog.ts` | No keyboard navigation/`aria-activedescendant` for the custom dropdown, no focus trap in the license dialog. Needs a proper keyboard pass. |
| m17 | Minor | Docs / AI context | `.ai/project/preferences.md:1-60`, `.ai/project/architecture.md:94`, `CLAUDE.md:62,103`, `README.md:435` | `preferences.md` is still the unfilled .NET template; architecture claims `getWorkspaceFolder()` validation (code uses `startsWith`); `ExecuteCommand` vs `ExecuteCommandAsync`; `.vscode-test.mjs` vs `.vscode-test.js`; `types.ts` vs `types.d.ts`. |
| m18 | Minor | Repo state | `git status` | The template migration is uncommitted: `.ai/` is entirely untracked, `.claude/*` content is deleted (some staged, some unstaged), and `.claude/skills` is now a gitignored junction. A partial commit would delete the old knowledge base without adding `.ai/`. |
| m19 | Minor | Developer workflow | `.vscode/tasks.json:8`, `.vscode/launch.json:34,39` | The default build task references a missing `npm: watch`; the Extension Tests launch config references a non-existent `out/test/suite/index`. F5/Ctrl+Shift+B fail. |
| m20 | Minor | Types | `src/common/types.d.ts:83` | `LatestCompatibleVersion` is never written or read; the implemented field is `LatestOverallVersion`. |

---

## Blocker details and fixes

### B1 — Workspace-controlled script execution (RCE)

**Evidence**
- `package.json:127-138`: the `sources` setting is a plain array with no `"scope": "machine"`.
- `nuget-config-resolver.ts:74-93`: `passwordScriptPath` is read from that setting and passed to `PasswordScriptExecutor.ExecuteScriptAsync` whenever the source also has a password.
- `password-script-executor.ts:26-51`: `.ps1` runs through `powershell.exe -ExecutionPolicy Bypass -File`; `.bat`/`.cmd` through `cmd /c`; `.sh` through `sh`. `cwd` is `process.cwd()` and `env` is the full `process.env`.
- No `capabilities.untrustedWorkspaces` in `package.json`; no `vscode.workspace.isTrusted` check anywhere in `src/`.

**Attack**
1. Repository contains `.vscode/settings.json` with a source whose `passwordScriptPath` is `./scripts/nuget.ps1`, and a `nuget.config` with a matching source that has a password.
2. User opens the folder and opens the NuGet view (which calls `GetSourcesAndDecodePasswordsAsync`).
3. The script runs with the user's privileges.

**Fix**
- Mark the setting `"scope": "machine"` (or split script paths into a machine-scoped setting).
- Add `"capabilities": {"untrustedWorkspaces": {"supported": false}}` and check `vscode.workspace.isTrusted` before any script, `dotnet msbuild`, `restore`, or `add`.
- Validate the script path with `path.resolve` + `realpath`, require it to be inside an explicitly trusted directory (never the workspace by default), and require a per-source confirmation.
- Drop `-ExecutionPolicy Bypass` or require a signed script.

### B2 — Unconditional CPM update rewrites conditional lines

**Evidence**
- `updates-view.ts:158`: `Scope: pkg.CpmCondition ? "group" : "all"`.
- `host-api.ts:840-864`: the batch handler only defaults `scope` when it is `undefined`; the explicit `"all"` survives.
- `cpm-resolver.ts:337-342`: `replaceInElements(..., global = scope === "all")` rewrites every matching `PackageVersion` in the file.
- `cpm-resolver.ts:415-420`: verification requires every occurrence to equal the new version, so the corrupted state is accepted.

**Reproduction** — use `src/host/utilities/__fixtures__/cpm/unconditional-plus-conditional.props` (`Pkg.Shared` has an unconditional `1.0.0` and a net10 `2.0.0`). Update the unconditional row to `1.5.0`; both entries become `1.5.0`.

**Fix**
- Do not send `Scope: "all"` for unconditional rows. Add an explicit `"unconditional"` scope to the host and make it update only unconditional `ItemGroup`s.
- Make `verifyChanges` assert that only the intended group changed, not merely that the target group has the new value.
- Add a host-level test for the unconditional+conditional fixture through `batchUpdatePackagesAsync`.

### B3 — Workspace containment is broken and easy to bypass

**Evidence** — `host-api.ts:471-475`:
```ts
const normalizedProject = request.ProjectPath.replace(/\//g, "\\");
const inWorkspace = workspacePaths.some((root) => normalizedProject.startsWith(root));
```
On a POSIX host the first line turns `/home/u/proj/App.csproj` into `\home\u\proj\App.csproj`, which can never start with `/home/u/proj`. On Windows, `C:\ws\proj-evil\App.csproj` starts with `C:\ws\proj`. There is no `path.resolve`/`realpath`, no separator boundary, and no case folding. `batchUpdatePackagesAsync`, `consolidatePackagesAsync` and `restoreProjectsAsync` have no check.

**Fix**
- Centralise in one `assertInWorkspace(uri)` used by every path-taking RPC (or normalise once in `RpcHost`).
- Use `path.resolve` + `fs.realpath`, compare with `path.relative(root, candidate)` and reject absolute results or results starting with `..` + separator, case-insensitively on Windows.
- Add host tests that run on both separators (`/ws/App.csproj` and `C:\ws\App.csproj`) and for `..`/`-evil`/symlink escapes.

### B4 — Workspace credentials can exfiltrate process secrets

**Evidence**
- `nuget-config-resolver.ts:355-358`: `authToken.replace(/%([^%]+)%/g, (_, varName) => process.env[varName] ?? "")` applies to every config file, including the workspace one.
- `api-factory.ts:24`: credentials are matched to a source by URL.
- `api.ts:82-92`: the resulting Basic header is installed on all requests from that instance.

**Attack** — a repository `nuget.config` declares `https://attacker.tld/v3/index.json` with `Username="x"` and `ClearTextPassword="%GITHUB_TOKEN%"`; the next package request sends the token to the attacker.

**Fix**
- Do not expand `%VAR%` for credentials read from workspace-level configs; only allow user/machine scope, or an explicit allowlist (`NUGET_*`).
- Require confirmation before using credentials declared in a workspace config.
- Reject non-HTTPS sources when credentials are present.

---

## Major details worth acting on early

### M1 — Consolidate can report success after failure and wipe the wrong rows
`consolidate-view.ts:188` awaits the RPC but never checks `result.ok`; `:197` filters by `Id` only, so a net10 and net11 row for the same package both disappear after one consolidation. For unconditional rows it sends `Scope: "all"` (same as B2). Check the result, key the removal by `(Id, CpmCondition, CpmFramework)`, and use the same explicit scope rules as B2.

### M2/M15 — Timeouts and cancellation
`rpc-client.ts:53-56` resolves a timeout failure but never posts `rpc-cancel`; `rpc-host.ts` therefore does not abort. `TaskExecutor.ExecuteCommandAsync` accepts no `AbortSignal` and has no process timeout. Add a cancel post on timeout, thread the signal into `TaskExecutor`, kill the child and release the mutex in a `finally`, and test the timeout path with fake timers.

### M3 — Per-project updates lose the framework line
`project-row.ts:68-74` sends only `PackageId`/`Version`. `updateProjectAsync` then uses `first` for ambiguous packages (`host-api.ts:510-521`). Add `CpmCondition`/`CpmTfm` to `UpdateProjectRequest` and pass them from the selected package row, or disable the per-project action for multi-group packages and route users to the Updates tab.

### M4 — Element-level CPM conditions
`cpm-resolver.ts:574` reads only the `ItemGroup` condition. Support `PackageVersion[@Condition]` (evaluate it against the TFM) or explicitly reject/skip such entries with a warning rather than treating them as unconditional.

### M5 — Validate before writing XML
Add NuGet package-id and version grammars:
- id: `^[A-Za-z0-9._-]{1,100}$`
- version: the NuGet SemVer subset (`major.minor.patch[.revision][-prerelease][+metadata]`), with no quotes/angle brackets/control characters.
Escape attribute values and write via temp file + `rename` after verification.

### M6 — Vulnerability data
Normalise both feed and installed keys to lowercase when inserting into `allVulnerabilities`, return the original package id, and only cache a complete fetch (track whether any page failed; do not overwrite a good cache with a partial one).

### M7 — Latest version
Sort registration items with the shared `compareVersions` before choosing the last one. This is the same comparator the Updates path uses; keeping them consistent prevents the details pane and Updates tab disagreeing.

### M8 — Scope credentials to the source origin
The interceptor should add `Authorization` only when `new URL(config.url).host` equals the configured source host. Validate feed-supplied registration/catalog URLs the same way, and refuse `http:` for authenticated sources.

### M9 — Packaging
Add `.ai/**`, `AGENTS.md`, `test-path-register.cjs` and any remaining agent artifacts to `.vscodeignore`; run `vsce ls` in CI and assert `.ai/` is absent. `.ai/` is 12 MB today.

### M10 — Release gating
Make `publish` depend on a version change (compare `package.json` against the latest `v*` tag), skip an existing tag instead of failing, and keep `contents: write` scoped to the release job. Pin actions by SHA.

### M11/M12 — Tests and local verification
Add tests for the 11 untested host methods (start with `batchUpdatePackagesAsync` and `consolidatePackagesAsync`), the RPC transport, and the four feature tabs. Add `"pretest": "npm run test-compile"` so `npm test` works on a clean clone; correct the README wording.

### M13 — Eager tab mounting
Render only the active tab, or lazily instantiate each tab on first activation. This is the single largest startup cost on the 102-project framework workspace: four scans plus network calls before the user clicks anything.

### M16 — Sort
Add `Sort` to `GetPackagesRequest`, forward `filters.Sort` in `buildRequest()`, and implement it in `host-api.ts` (or remove the dropdown). Today it causes a refetch with no behavioural change.

---

## Strengths

- **CPM work is the best-tested area**: `cpm-condition` + `cpm-resolver` + `cpm-fixtures` cover negation, platform TFMs, document-order precedence, scoped writes, verify-before-write and a realistic set of fixture layouts (277 tests total).
- **Typed RPC discipline**: every host method returns `Result<T>`; the webview never receives credentials; `RpcHost` validates message shape and honours `rpc-cancel`.
- **No shell interpolation**: all `child_process` calls use argument arrays; `execFile` is used for MSBuild.
- **No HTML-injection sink**: no `innerHTML`/`unsafeHTML`; Lit text bindings and `preventDefault` before external links.
- **Strict TypeScript and CI gates**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; CI runs build, lint, `tsc --noEmit`, `npm audit --audit-level=high`, then the suite under xvfb.
- **CPM writes are mutexed per file and verified**; the per-file batching in batch update is a good design.

---

## Test coverage map

| Module | Test file(s) | Assessment |
|---|---|---|
| `cpm-condition.ts` (440) | `cpm-condition.test.ts` (16) | Good |
| `cpm-resolver.ts` (613) | `cpm-resolver.test.ts` (37), `cpm-fixtures.test.ts` (10) | Good |
| `project-framework-resolver.ts` (278) | `project-framework-resolver.test.ts` (7) | Partial — cache invalidation/concurrency missing |
| `nuget-config-resolver.ts` (371) | `nuget-config-resolver.test.ts` (26) | Partial — platform-conditional assertions |
| `nuget/api.ts` (443) | `api.test.ts` (30) | Partial — vulnerabilities/order/dead branches |
| `nuget/api-factory.ts` (50) | `api-factory.test.ts` (18) | Partial — several logger-only assertions |
| `host-api.ts` (1558) | `host-api.test.ts` (16) | Missing/thin — 11 of 18 RPCs, all write paths |
| `common/rpc/*` (432), `logger.ts`, `nonce.ts` | none | Missing |
| `extension.ts` (197) | none | Missing — activation, CSP, watcher |
| `packages-view.ts` (1240) | `packages-view.test.ts` (44) | Partial — controller only, `render()` untested |
| `package-row.ts`, `package-details.ts`, `search-bar.ts`, `project-row.ts` | respective tests | Partial/good render coverage |
| `updates/consolidate/vulnerabilities/settings-view`, `project-tree`, `dropdown`, dialogs, output log | none | Missing (≈2,069 lines) |
| `web/main.ts`, `router.ts`, `configuration.ts`, `registrations.ts`, `web-setup.ts` | none | Missing |

---

## Recommended remediation order

**P0 — before the next release**
1. B1 (script/trust), B4 (secret expansion), B3 (containment) — security boundary.
2. B2 + M1 — CPM scope/consolidation corruption, including host-level regression tests.
3. M9 (.vscodeignore) — do not ship `.ai/`.
4. M18 — commit `.ai/` and the `.claude` deletions together; do not land a partial migration.

**P1 — next iteration**
5. M2/M15 (cancel + process timeout), M3 (per-project TFM context), M4 (element conditions), M5 (XML validation), M6 (vulnerability keys/cache), M7 (latest sort), M8 (credential origin).
6. M10 (release gating), M11/M12 (host/RPC/UI tests + pretest), M13 (lazy tabs), M14 (visible failures), M16 (Sort).

**P2 — cleanup**
7. m1–m20: dead cache/settings/deps, CSP/openExternal/telemetry hardening, atomic writes, API-factory Map, docs drift, VS Code task/launch configs, type cleanup.

---

## Verification notes and limitations

- **Direct evidence** was gathered for every Blocker and the Major items cited with exact lines. The CPM scope defect, path check, RPC timeout, consolidate result handling, vulnerability key mismatch, registration ordering, `.vscodeignore`, CI publish and test-script issues were re-read from source.
- **No runtime exploit or PoC** was executed. The security findings are static; the workspace-trust assumptions about VS Code's default Restricted Mode behavior are documented behavior, not observed here.
- **Dependency advisories** were not queried online; CI already runs `npm audit --audit-level=high`. Inventory: axios 1.13.6, `@xmldom/xmldom` 0.8.11, xpath 0.0.34, lodash 4.17.23, object-hash 3.0.0.
- **No code was changed by this review.** `tsc`, ESLint and the 277-test suite were last run after the template migration; they pass on the current working tree.
