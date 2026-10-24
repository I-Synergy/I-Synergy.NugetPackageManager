# Plan: Whole-Application Review Remediation

**Status:** PROPOSED — awaiting approval
**Date:** 2026-10-24
**Source review:** `.ai/analysis/whole-application-review-2026-10-24.md`
**Scope:** all 40 findings (4 Blockers, 16 Majors, 20 Minors)

---

## 1. Context

The review found four release-blocking issues concentrated in the trust boundary, CPM
write scoping, path validation and credential handling, plus correctness and coverage gaps
in the host write paths, the RPC transport, the webview tabs, packaging and CI.

Current baseline: `tsc` clean, ESLint clean, 277 tests passing. No code has been changed
since the review.

**Constraint:** the `.claude/` → `.ai/` migration is still uncommitted. Remediation must
start from a committed base (see Step 0) so a partial commit cannot delete the old knowledge
base.

### Goals

- Remove the four Blockers before any release.
- Make CPM writes correct for every layout (unconditional, conditional, unconditional +
  conditional, element-level conditions).
- Make every path-taking RPC safe on Windows, Linux and macOS.
- Close the test gaps on the write paths and the RPC transport.
- Stop shipping `.ai/` in the `.vsix` and make releases intentional.
- Leave non-CPM and single-framework behaviour unchanged.

### Non-goals

- Rewriting the UI framework or the host/web architecture.
- Adding new NuGet features.
- Auditing third-party packages online (CI already runs `npm audit`).

---

## 2. Decisions required before implementation

These change behaviour and need an explicit choice. Recommended options are first.

| # | Decision | Options |
|---|---|---|
| D1 | Workspace Trust policy | **`capabilities.untrustedWorkspaces.supported: false`** (extension disabled in Restricted Mode) · `"limited"` (read-only browsing, XML-only TFM fallback, no scripts/dotnet) · leave current behaviour |
| D2 | Workspace password scripts | **Require a machine-scoped allowlist directory + per-source confirmation; drop `-ExecutionPolicy Bypass`** · keep Bypass behind confirmation · disallow scripts entirely |
| D3 | `%VAR%` expansion in workspace `nuget.config` | **Do not expand for workspace configs** · expand only `NUGET_*` variables · expand after explicit confirmation |
| D4 | Telemetry | **Add an explicit opt-in setting (default off)** · keep `isTelemetryEnabled` + env address · remove telemetry |
| D5 | Sort dropdown | **Implement sorting in the host** · remove the dropdown |
| D6 | Cross-platform support | **Fix path handling for Linux/macOS** · declare Windows-only in `package.json` and CI |

Unless told otherwise, the plan follows the bold options.

---

## 3. Workstreams

### Step 0 — Land the AI-context migration (prerequisite, no code)

**Findings:** M18.

- Review `git status`: `.ai/` untracked, `.claude/*` deletions staged/unstaged.
- Commit `.ai/` and the `.claude` deletions in one dedicated commit; verify junctions
  (`.claude/{skills,agents}`, `.github/{skills,agents}`, `.reasonix/{skills,agents}`) are
  ignored and not committed.
- Run `bash .ai/tests/run-all-tests.sh` and the repo suite from the committed tree.

**Acceptance:** `git status` shows a clean tree; `.ai/` is tracked; no junction paths are
tracked; the knowledge base is reachable from `AGENTS.md` and `CLAUDE.md`.

---

### Step 1 — Regression safety net (tests only)

Write the failing tests first so every fix is measurable.

| Finding | Test to add |
|---|---|
| B2 | Host-level `batchUpdatePackagesAsync` test using `__fixtures__/cpm/unconditional-plus-conditional.props`: updating the unconditional row must leave the net10 line at `2.0.0`. |
| B3 | `workspace-path.test.ts`: POSIX and Windows paths, `..`, sibling prefix (`root-evil`), symlink/realpath, case-insensitive Windows. |
| B4/B1 | Config tests: workspace `%VAR%` is not expanded; untrusted workspace does not execute a script; allowlist rejection. |
| M1 | `consolidate-view.test.ts`: failed RPC keeps the row and shows an error; two TFM rows with the same Id are removed independently. |
| M2 | `rpc-client.test.ts` / `rpc-host.test.ts`: timeout posts `rpc-cancel`; cancel aborts the handler; no response after abort. |
| M3 | Host test: ambiguous conditional package without `CpmCondition` refuses or uses the supplied TFM. |
| M4 | Parser test: `<PackageVersion Condition="...">` resolves per TFM and is written in place. |
| M5 | `nuget-identifier.test.ts`: valid/invalid IDs and versions; XML metacharacters rejected. |
| M6 | Vulnerability test: mixed-case feed keys match; partial fetch is not cached. |
| M7 | API test: registration items in descending order still yield the SemVer latest. |
| M11/M12 | At least one test per host write path and per web tab, plus `pretest` so `npm test` compiles first. |

**Acceptance:** new tests fail on the current code for the intended reason (except tests for
features not yet implemented), and the suite is runnable from a clean clone.

---

### Step 2 — P0 Blockers

#### B1 — Workspace-controlled script execution

Files: `package.json`, `src/host/utilities/nuget-config-resolver.ts`,
`src/host/utilities/password-script-executor.ts`, `src/host/extension.ts`.

- Add `capabilities.untrustedWorkspaces.supported: false` (D1).
- Read `passwordScriptPath` only when `vscode.workspace.isTrusted` (or limited mode allows
  reading but never executing).
- Add a machine-scoped `passwordScriptAllowlist` (array of directories). Resolve the script
  with `path.resolve` + `fs.realpath`; reject if not under an allowlisted directory.
- Require a per-source confirmation before first execution; persist the approval in
  `workspaceState` keyed by source + script hash.
- Drop `-ExecutionPolicy Bypass`; document that scripts must be signed/executable per the
  user's policy (D2).
- Never echo script stdout/stderr into logs or error messages.

**Acceptance:** a workspace `.vscode/settings.json` + `nuget.config` cannot execute a script
in an untrusted workspace; an unallowlisted path is rejected; credentials are not logged.

#### B2 — CPM unconditional scope corruption

Files: `src/common/rpc/types.ts`, `src/host/host-api.ts`,
`src/host/utilities/cpm-resolver.ts`, `src/web/components/updates-view.ts`,
`src/web/components/consolidate-view.ts`.

- Add `scope: "unconditional"` to `CpmVersionChange` and the RPC request types.
- Implement `unconditional` in `applyVersionChange`: rewrite only `PackageVersion` elements
  that live in an `ItemGroup` without a `Condition` (all such groups, not just the first).
- Change the Updates row to `CpmCondition ? "group" : "unconditional"`.
- Consolidate uses the same rule.
- Strengthen `verifyChanges`: for `group`, assert other groups are unchanged; for
  `unconditional`, assert conditional groups are unchanged; for `all`, keep the current
  all-occurrences check.

**Acceptance:** the `unconditional-plus-conditional` fixture keeps `Pkg.Shared` at `2.0.0`
on net10 after updating the unconditional row; a regression test covers the UI request and
the host.

#### B3 — Path containment

Files: new `src/host/utilities/workspace-path.ts`, `src/host/host-api.ts`,
`src/host/utilities/cpm-resolver.ts`.

- Implement `assertInWorkspaceAsync(candidate, workspaceFolders)`:
  `path.resolve` → `fs.realpath` (fallback to resolved path if missing) → `path.relative` →
  reject absolute results or results starting with `..` + separator; case-insensitive on
  `win32`.
- Apply it to `updateProjectAsync`, `batchUpdatePackagesAsync`, `consolidatePackagesAsync`,
  `restoreProjectsAsync`, and any new path-taking RPC. Reject a resolved
  `Directory.Packages.props` outside the workspace for writes.
- Keep the existing user-facing error format.

**Acceptance:** POSIX and Windows tests pass; `..`, sibling-prefix, and symlink escapes are
rejected; all write RPCs share the helper.

#### B4 — Credential expansion / exfiltration

Files: `src/host/utilities/nuget-config-resolver.ts`, `src/host/nuget/api.ts`,
`src/host/nuget/api-factory.ts`, `package.json`.

- Track the config scope when parsing (`machine`, `user`, `workspace`).
- Do not expand `%VAR%` for workspace configs (D3); expand only for user/machine configs, or
  only `NUGET_*` variables if the user chooses that option.
- Reject credentials for non-HTTPS sources; warn before using workspace-declared credentials.
- Add a test: workspace config with `%GITHUB_TOKEN%` produces no token and no auth header.

**Acceptance:** no process-environment secret can be sent to a workspace-declared feed.

---

### Step 3 — CPM correctness (M1, M3, M4, M11 ordering, m11)

#### M1 — Consolidate result handling and row removal

Files: `src/web/components/consolidate-view.ts`, `src/host/host-api.ts`.

- Check `result.ok`; on failure keep the row, set an error status, and do not remove other
  rows.
- Remove by `(Id, CpmCondition, CpmFramework)` rather than `Id`.
- `consolidateAllAsync` collects per-package failures and reports them.
- Use the explicit scope rules from B2.

**Acceptance:** failure test keeps the row; two TFM rows survive an update of the other.

#### M3 — Per-project updates keep TFM context

Files: `src/common/rpc/types.ts`, `src/web/types.ts`,
`src/web/components/{package-details,project-row,packages-view}.ts`,
`src/host/host-api.ts`.

- Add optional `CpmCondition` and `CpmTfm` to `UpdateProjectRequest`; carry them on
  `PackageViewModel`/`ProjectPackageViewModel` through selection.
- `updateProjectAsync`: if the package has multiple conditional groups and no condition is
  supplied, return `fail("This package has several framework versions; update it from the
  Updates tab")` instead of guessing. Never silently write the first group.
- Single-group packages keep working without the extra fields.

**Acceptance:** updating a net11 row from the details pane writes only the net11 group;
ambiguous requests fail with a clear message.

#### M4 — Element-level CPM conditions

Files: `src/host/utilities/cpm-resolver.ts`, `src/host/utilities/cpm-condition.ts`,
`src/host/host-api.ts`.

- Extend the model so each `PackageVersion` carries its effective condition
  (`ItemGroup Condition` AND `PackageVersion Condition`) and document order.
- Resolve per TFM using the combined condition; surface the label.
- Write scope `group` must locate the `PackageVersion` element and update it in place when
  the element has its own condition; keep the ItemGroup path for group-level conditions.
- If the combined grammar is unsupported, mark the entry `Matched: false` and do not write
  without an explicit condition.
- Add fixtures: element-only condition, group+element combination, repeated condition across
  ItemGroups (m11).

**Acceptance:** new fixtures resolve and update correctly; repeated-condition ordering uses
the last occurrence.

---

### Step 4 — Security Majors and hardening (M5–M8, m5–m10, m13)

#### M5 — Validate before writing XML

Files: new `src/host/utilities/nuget-identifier.ts`, `cpm-resolver.ts`, `host-api.ts`.

- `isValidPackageId` (`^[A-Za-z0-9._-]{1,100}$`) and `isValidNuGetVersion` (NuGet SemVer
  subset; reject quotes, `<`, `>`, control characters).
- Validate in `batchUpdatePackagesAsync`, `consolidatePackagesAsync`,
  `updateProjectAsync`, and `UpdateCpmVersionsAsync` (defence in depth).
- XML-escape attribute values or reject; write via temp file + `rename` after verification
  (m8).

**Acceptance:** table-driven invalid inputs are rejected before any file write; the existing
fixtures still pass.

#### M6 — Vulnerability keys and partial cache

Files: `src/host/host-api.ts`, `src/host/nuget/api.ts`.

- Lowercase feed keys on insert into `allVulnerabilities`; preserve the original package ID
  for output.
- Track whether every vulnerability page succeeded; only replace `_vulnerabilityCache` on a
  complete fetch. On failure, keep the previous cache or mark it stale.
- Add mixed-case and partial-fetch tests.

#### M7 — Latest version ordering

Files: `src/host/nuget/api.ts`.

- Sort registration items with the shared `compareVersions` before selecting the last.
- Add a test with pages returned out of order.
- Optionally move `compareVersions` to `src/host/utilities/version.ts` so it can be tested
  directly (also M11 coverage).

#### M8 — Credentials only to the source origin

Files: `src/host/nuget/api.ts`, `src/host/host-api.ts`.

- Store the configured source host; add `Authorization` only when `config.url` has the same
  host (and same protocol).
- Reject feed-supplied absolute URLs that change host; build relative URLs from the source.
- Validate `PackageVersionUrl` against the same origin.

#### m5–m10, m13 — Hardening

- m5: allow only `https:` (and `http:` only for non-credentialed sources) in
  `openUrlAsync`.
- m6: full CSP (`default-src 'none'`, `style-src`, `img-src`, `connect-src 'none'`,
  `base-uri`, `form-action`) and explicit `localResourceRoots`.
- m7: add a telemetry opt-in setting; hash/remove `machineId`/`sessionId`; scrub paths and
  usernames from log-derived spans (D4).
- m8: atomic CPM writes (temp + fsync + rename, re-stat before replace).
- m9: `Map` in `api-factory`.
- m10: support token-only credentials (username optional).
- m13: stop retaining decoded passwords in the dead `CredentialsCache`; remove the module
  and its stub, or wire it and clear on deactivate.
- m1: delete the write-only cache and update docs.

---

### Step 5 — Reliability and cancellation (M2, M15, m2, m3, m4, m12, m14)

#### M2 / M15 — Cancellation and process timeouts

Files: `src/common/rpc/rpc-client.ts`, `src/common/rpc/rpc-host.ts`,
`src/host/utilities/task-executor.ts`, handlers in `host-api.ts`.

- On RPC timeout, post `rpc-cancel` before resolving `fail`.
- Thread `AbortSignal` into `TaskExecutor.ExecuteCommandAsync`; add a configurable process
  timeout (default 10 minutes); `kill` the child on abort/timeout.
- Release the mutex in a `finally`; use `close`/`error`/`exit` exactly once.
- Ensure long loops (`restoreProjectsAsync`, `batchUpdatePackagesAsync`,
  `getOutdatedPackagesAsync`) check `signal.aborted` between projects and stop cleanly.
- Add fake-timer tests for timeout/cancel/abort.

#### Other reliability

- m2: clear the decorator debounce timer in `dispose()`; correct the README click claim.
- m3: remove the three dead settings (or wire them).
- m4: declare all imported OTel packages; remove `object-hash` and `@types/object-hash`.
- m12: add cache-invalidation and concurrency-gate tests.
- m14: project-row shows an error and emits a failure event.

---

### Step 6 — UI/UX and accessibility (M13, M14, M16, m16, m19)

- M13: render only the active tab, or add an `active` property so each tab loads on first
  activation. Keep counts and refresh-on-switch behaviour. Add render tests.
- M14: visible failure state for install/update (also covered above).
- M16: add `Sort` to `GetPackagesRequest`, forward `filters.Sort`, implement
  downloads/name/recent sorting in the host, or remove the dropdown (D5).
- m16: keyboard navigation + `aria-activedescendant` for the custom dropdown; focus trap and
  Escape handling for the license dialog; ARIA tabpanel wiring.
- m19: fix `.vscode/tasks.json` (point at `esbuild`, or add `watch`) and
  `.vscode/launch.json` (extension-host test configuration).

**Acceptance:** clicking each tab loads only that tab; Sort changes result order; keyboard
tests cover dropdown/dialog.

---

### Step 7 — Packaging, release and documentation (M9, M10, M12, m17–m20)

- M9: add `.ai/**`, `AGENTS.md`, `test-path-register.cjs` and any agent artifacts to
  `.vscodeignore`; run `vsce ls` in CI and assert `.ai/` is absent.
- M10: publish only when `package.json` version is newer than the latest `v*` tag; make
  tagging idempotent; scope `contents: write` to the release job; pin actions by SHA.
- M12: add `"pretest": "npm run test-compile"`; correct README’s test-compile description.
- m17: fix `.ai/project/preferences.md` (fill it for TypeScript or delete it),
  `architecture.md` (no `getWorkspaceFolder` claim), `ExecuteCommandAsync`, `.vscode-test.js`,
  `types.d.ts`, and the extension id.
- m18: covered by Step 0.
- m19: covered in Step 6.
- m20: remove the dead `LatestCompatibleVersion` type.

---

### Step 8 — Test coverage and final validation

- Add `host-api` tests for every RPC method; prioritize:
  `batchUpdatePackagesAsync`, `consolidatePackagesAsync`, `updateProjectAsync`,
  `restoreProjectsAsync`, `getInconsistentPackagesAsync`, `getVulnerablePackagesAsync`,
  `updateConfigurationAsync`, `openUrlAsync`.
- Add `rpc-client.test.ts`, `rpc-host.test.ts`, `version.test.ts` (compare/ranges),
  `workspace-path.test.ts`, `nuget-identifier.test.ts`.
- Add jsdom tests for `updates-view`, `consolidate-view`, `vulnerabilities-view`,
  `settings-view`, `project-tree`, `dropdown`, and a mount smoke test for `packages-view`.
- Fix weak tests: logger-only assertions, conditional home-directory assertions, real timers.
- Final verification:
  - `npm run esbuild`, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm audit`.
  - `bash .ai/tests/run-all-tests.sh`.
  - `npx @vscode/vsce ls` → no `.ai/`, no `AGENTS.md`, no tests.
  - Manual/e2e against `D:\Projects\I-Synergy\I-Synergy.Framework`: net10/net11 rows,
    unconditional+conditional fixture, scoped writes, restore, cancellation.
  - CI: verify the publish gate on a non-release commit (dry run) and on a version bump.

---

## 4. Finding-to-step map

| Finding | Step |
|---|---|
| B1 | 2 (B1) |
| B2 | 2 (B2) |
| B3 | 2 (B3) |
| B4 | 2 (B4) |
| M1 | 3 (M1) |
| M2 | 5 (M2/M15) |
| M3 | 3 (M3) |
| M4 | 3 (M4) |
| M5 | 4 (M5) |
| M6 | 4 (M6) |
| M7 | 4 (M7) |
| M8 | 4 (M8) |
| M9 | 7 |
| M10 | 7 |
| M11 | 8 |
| M12 | 7 |
| M13 | 6 |
| M14 | 5/6 |
| M15 | 5 |
| M16 | 6 |
| m1 | 4 (m1/m13) |
| m2 | 5 |
| m3 | 5 |
| m4 | 5 |
| m5 | 4 |
| m6 | 4 |
| m7 | 4 |
| m8 | 4 |
| m9 | 4 |
| m10 | 4 |
| m11 | 3 (M4) |
| m12 | 5/8 |
| m13 | 4 |
| m14 | 5 |
| m15 | 8 |
| m16 | 6 |
| m17 | 7 |
| m18 | 0 |
| m19 | 6/7 |
| m20 | 7 |

---

## 5. Delivery sequence

| Milestone | Contents | Exit criteria |
|---|---|---|
| M0 | Step 0 + Step 1 | Clean committed base; failing regression tests in place |
| M1 | B1–B4 | All Blocker tests pass; `tsc`/lint/tests green |
| M2 | M1, M3, M4, m11 | CPM fixtures + host tests green; consolidate failure visible |
| M3 | M5–M8, m5–m10, m13 | Security regression tests green; `npm audit` clean |
| M4 | M2/M15, m1–m4, m12, m14 | Timeout/cancel tests green; no hung-mutex path |
| M5 | M13, M14, M16, m16, m19 | Tab laziness, Sort and keyboard tests green |
| M6 | M9, M10, M12, m17–m20 | `vsce ls` clean; release gate dry-run passes |
| M7 | Step 8 | Full suite, AI template suite, framework e2e, packaging checks |

Each milestone is a separate commit/PR with its own tests. Do not batch Blockers and
packaging into one commit.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Workspace Trust `supported: false` disables the extension for some users | Announce in CHANGELOG/README; consider a limited mode (XML-only, no scripts/dotnet) as a follow-up |
| Dropping `-ExecutionPolicy Bypass` breaks existing password scripts | Document the change; provide the allowlist + confirmation path; offer a temporary opt-in setting |
| Stricter CPM scope changes existing update behaviour | Keep `group`/`all` tests; add a migration note; unconditional rows now use the new scope |
| Element-level condition refactor touches the verified CPM model | Land behind new fixtures first; keep the old model tests green |
| Lazy tabs change count badges | Keep counts in the parent and refresh on activation; add tests |
| CI publish gate could skip a legitimate release | Compare against the latest tag and allow a manual `workflow_dispatch` override |
| Path realpath on Windows junctions/symlinks | Fall back to the resolved path when `realpath` fails; test with a junction |

---

## 7. Estimated effort

| Workstream | Estimate |
|---|---|
| Step 0 — migration commit | 0.5 day |
| Step 1 — regression tests | 2 days |
| Step 2 — Blockers | 3–4 days |
| Step 3 — CPM correctness | 3–4 days |
| Step 4 — security/hardening | 3–4 days |
| Step 5 — reliability/cancellation | 2–3 days |
| Step 6 — UI/accessibility | 3–4 days |
| Step 7 — packaging/release/docs | 1–2 days |
| Step 8 — coverage + final validation | 3–5 days |
| **Total** | **~20–29 dev days** |

A reduced release scope (Steps 0–2 plus M9/M10/M12) is ~8–10 days and removes all Blockers
and the release/packaging risks.

---

## 8. Approval checklist

- [ ] Decisions D1–D6 answered
- [ ] Milestones M0–M7 approved (or a reduced scope selected)
- [ ] Progress file created at `.ai/progress/review-remediation.md`
- [ ] No code changes before approval
