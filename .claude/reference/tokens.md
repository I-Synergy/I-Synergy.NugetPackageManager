# Reference Tokens

## Special Files (Always in .claude/)

| File | Purpose |
|------|---------|
| `session-context.md` | Read FIRST at session start; update before session end |
| `progress/{task}.md` | Active task progress (`- [ ]` / `- [x]`) |
| `completed/{task}.md` | Completed task archives |
| `plans/{slug}.md` | Design plans and proposals |

## Key Source Paths

| Path | Purpose |
|------|---------|
| `src/common/rpc/types.ts` | HostAPI interface + all request/response types |
| `src/host/host-api.ts` | Host-side implementation of all RPC methods |
| `src/host/utilities/task-executor.ts` | dotnet CLI execution + progress tracking |
| `src/web/registrations.ts` | Module-level singletons: `hostApi`, `router`, `configuration` |
| `src/web/main.ts` | Webview entry point + root `nuget-packages-manager` component |
| `src/host/extension.ts` | Extension activation, RpcHost setup |
| `esbuild.js` | Dual bundle build config |
| `.vscode-test.mjs` | Test runner configuration |
