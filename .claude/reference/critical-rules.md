# Critical Rules (Read First)

These are non-negotiable patterns for this TypeScript VS Code extension. Violating them causes bugs or security issues.

## 1. src/common/ Must Be Isomorphic

Files in `src/common/` are bundled into **both** the host (Node.js) and web (browser) bundles. They must never import Node.js-only modules.

```ts
// CORRECT — works in both Node.js 19+ and browser
globalThis.crypto.randomUUID()

// WRONG — Node.js only, will break the web bundle
import { randomBytes } from "crypto";
import { randomUUID } from "crypto";
```

## 2. RPC Methods Always Return Result<T>

Never throw from a host-side RPC handler. Always return `ok(value)` or `fail(message)`.

```ts
// CORRECT
async function getProjects(req: GetProjectsRequest): Promise<Result<GetProjectsResponse>> {
  try {
    const projects = await loadProjects();
    return ok({ Projects: projects });
  } catch (e) {
    return fail(`Failed to load projects: ${e}`);
  }
}

// WRONG — throws propagate as unhandled rejections
async function getProjects(req: GetProjectsRequest) {
  const projects = await loadProjects(); // throws on error
  return { Projects: projects };
}
```

## 3. Add New RPC Methods in All Three Places

Adding a method to `HostAPI` requires changes in exactly three files — missing any breaks the contract:

1. `src/common/rpc/types.ts` — request/response types + `HostAPI` interface method
2. `src/host/host-api.ts` — implementation function
3. Webview caller — `hostApi.methodName(request)` call site

## 4. Path and URL Validation Before dotnet CLI

All host-side code that passes paths or URLs to the dotnet CLI must validate first.

```ts
// CORRECT — validate path is inside a workspace folder
const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath));
if (!wsFolder) return fail("Project path is outside workspace");

// CORRECT — validate URL before passing to dotnet
try { new URL(sourceUrl); } catch { return fail("Invalid source URL"); }

// WRONG — passing untrusted input directly
spawn("dotnet", ["add", projectPath, "package", id, "--source", sourceUrl]);
```

## 5. Event Listeners Must Be Stored and Cleaned Up

Store event listeners as class fields (arrow functions or bound references) so they can be removed in `disconnectedCallback`.

```ts
// CORRECT
private readonly onMessage = (e: MessageEvent) => { ... };

connectedCallback() {
  super.connectedCallback();
  window.addEventListener("message", this.onMessage);
}

disconnectedCallback() {
  window.removeEventListener("message", this.onMessage);
  super.disconnectedCallback();
}

// WRONG — anonymous listener cannot be removed
connectedCallback() {
  window.addEventListener("message", (e) => { ... });
}
```

## 6. Progress Polling Must Stop

When a component starts polling `getOperationProgress`, it must stop on:
- `Active === false` in the response
- `disconnectedCallback()`

Failing to stop polling leaks timers and keeps the RPC connection busy.

## 7. Script Execution: Explicit Extension Allowlist

Password credential scripts are restricted to `.ps1`, `.bat`, `.cmd`, `.sh`. Any other extension must be rejected.

```ts
// CORRECT
const ALLOWED_SCRIPT_EXTENSIONS = [".ps1", ".bat", ".cmd", ".sh"];
if (!ALLOWED_SCRIPT_EXTENSIONS.includes(ext)) {
  return fail(`Unsupported script extension: ${ext}`);
}
```

## 8. Progress Files: Current Project Only

Progress files MUST be in this project's `.claude/` folder.

```
CORRECT:   .claude/progress/task-slug.md
WRONG:     ~/.claude/progress/task-slug.md
```

## 9. Plan Files: .claude/plans/

```
CORRECT:   .claude/plans/2026-03-17-feature-name.md
WRONG:     docs/plans/feature-name.md
```

## 10. Session Context: Read First, Update Last

Every session MUST:
1. Read `.claude/session-context.md` FIRST
2. Update it with learnings before ending

## Quick Violation Checklist

Before committing, verify:

- [ ] `src/common/` files use `globalThis.crypto`, not `import ... from "crypto"`
- [ ] RPC handlers return `Result<T>` (never throw)
- [ ] New RPC methods added in `types.ts` + `host-api.ts` + call site
- [ ] Project paths validated against workspace folders before dotnet CLI
- [ ] Source URLs validated with `new URL()` before dotnet CLI
- [ ] Event listeners stored as class fields; removed in `disconnectedCallback`
- [ ] Progress polling stopped on `Active=false` and `disconnectedCallback`
- [ ] Script extensions validated against allowlist
- [ ] `npm run esbuild` passes (0 errors)
- [ ] `npm run lint` passes (0 errors)
