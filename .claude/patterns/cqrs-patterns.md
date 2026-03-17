# RPC Patterns

This project uses a typed RPC layer (not CQRS) for host ↔ webview communication. The patterns below document the established conventions.

## Adding a New RPC Method

### Step 1: types.ts — define the contract

```ts
// src/common/rpc/types.ts

export type MyNewRequest = {
  SomeParam: string;
  AnotherParam?: number;
};

export type MyNewResponse = {
  ResultData: SomeType[];
};

export interface HostAPI {
  // ...existing methods...
  myNewMethod(req: MyNewRequest): Promise<Result<MyNewResponse>>;
}
```

### Step 2: host-api.ts — implement on the host

```ts
// src/host/host-api.ts

export async function myNewMethod(
  req: MyNewRequest,
  context: HostContext
): Promise<Result<MyNewResponse>> {
  try {
    const data = await doSomething(req.SomeParam);
    return ok({ ResultData: data });
  } catch (e) {
    return fail(`myNewMethod failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

### Step 3: webview call site

```ts
// In a Lit component
const result = await hostApi.myNewMethod({ SomeParam: "value" });
if (!result.ok) {
  this.error = result.error;
  return;
}
const data = result.value.ResultData;
```

## Result<T> Pattern

```ts
import { ok, fail } from "@/common/rpc/result";

// Success
return ok({ Projects: projectList });

// Failure (never throw — always return fail())
return fail("Could not parse project file");
```

## Progress Operation Pattern

For long-running operations (install/update/uninstall):

```ts
// Webview: generate operationId before calling
const operationId = `install-${packageId}-${Date.now()}`;
const result = await hostApi.updateProject({ ..., OperationId: operationId });

// Start polling
this.pollInterval = setInterval(async () => {
  const progress = await hostApi.getOperationProgress({ OperationId: operationId });
  if (!progress.ok || !progress.value.Active) {
    clearInterval(this.pollInterval);
    return;
  }
  this.stage = progress.value.Stage;
  this.percent = progress.value.Percent;
}, 300);

// Always clean up on disconnect
disconnectedCallback() {
  clearInterval(this.pollInterval);
  super.disconnectedCallback();
}
```

## Error Handling in Components

```ts
// Standard pattern: reset error, call RPC, handle result
this.error = null;
const result = await hostApi.someMethod(req);
if (!result.ok) {
  this.error = result.error;
  return;
}
this.data = result.value;
```

## Cache Busting

Pass `ForceReload: true` to bypass in-memory cache:

```ts
await hostApi.getProjects({ ForceReload: true });
await hostApi.getOutdatedPackages({ Prerelease: false, ForceReload: true });
```
