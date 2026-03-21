import type { HostAPI, RpcRequest, RpcResponse, RpcCancel } from "./types";
import type { Result } from "./result";
import { fail } from "./result";

type PendingCall = {
  resolve: (result: Result<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: (() => void) | undefined;
};

export function createRpcClient(
  postMessage: (msg: unknown) => void,
  timeoutMs: number = 30_000
): HostAPI {
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as RpcResponse;
    if (msg?.type !== "rpc-response") return;

    const call = pending.get(msg.id);
    if (!call) return;

    clearTimeout(call.timer);
    call.cleanup?.();
    pending.delete(msg.id);
    call.resolve(msg.result);
  });

  function call(method: string, params: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    return new Promise<Result<unknown>>((resolve) => {
      if (signal?.aborted) {
        resolve(fail("cancelled"));
        return;
      }

      const id = nextId++;

      const cancel = (): void => {
        const c = pending.get(id);
        if (!c) return;
        clearTimeout(c.timer);
        pending.delete(id);
        postMessage({ type: "rpc-cancel", id } satisfies RpcCancel);
        resolve(fail("cancelled"));
      };

      const cleanup = signal ? (): void => { signal.removeEventListener("abort", cancel); } : undefined;

      signal?.addEventListener("abort", cancel, { once: true });

      const timer = setTimeout(() => {
        pending.delete(id);
        cleanup?.();
        resolve(fail(`RPC timeout after ${timeoutMs}ms for method: ${method}`));
      }, timeoutMs);

      pending.set(id, { resolve, timer, cleanup });

      const request: RpcRequest = {
        type: "rpc-request",
        id,
        method,
        params,
      };
      postMessage(request);
    });
  }

  return new Proxy({} as HostAPI, {
    get(_target, prop: string) {
      return (params: unknown, signal?: AbortSignal) => call(prop, params, signal);
    },
  });
}
