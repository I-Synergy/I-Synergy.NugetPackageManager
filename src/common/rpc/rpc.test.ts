import '../../web/web-setup';
import * as assert from 'assert';
import * as sinon from 'sinon';
import type { HostAPI, RpcCancel, RpcRequest, RpcResponse } from './types';
import { createRpcClient } from './rpc-client';
import { RpcHost } from './rpc-host';
import { Logger } from '../logger';

suite('RPC transport', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'warn');
        sandbox.stub(Logger, 'error');
    });

    teardown(() => {
        sandbox.restore();
    });

    function respond(id: number, value: unknown): void {
        const response: RpcResponse = { type: 'rpc-response', id, result: { ok: true, value } };
        window.dispatchEvent(new window.MessageEvent('message', { data: response }));
    }

    test('resolves an RPC response by id', async () => {
        const sent: RpcRequest[] = [];
        const client = createRpcClient((msg) => sent.push(msg as RpcRequest), 1000);

        const promise = client.getProjectsAsync({});
        assert.strictEqual(sent.length, 1);
        respond(sent[0]!.id, { Projects: [] });

        const result = await promise;
        assert.strictEqual(result.ok, true);
    });

    test('posts rpc-cancel on timeout and fails the call', async () => {
        const sent: Array<RpcRequest | RpcCancel> = [];
        const client = createRpcClient((msg) => sent.push(msg as RpcRequest | RpcCancel), 20);

        const promise = client.getProjectsAsync({});
        await new Promise((resolve) => setTimeout(resolve, 40));
        const result = await promise;

        assert.strictEqual(result.ok, false);
        assert.ok(sent.some((msg) => (msg as RpcCancel).type === 'rpc-cancel'));
    });

    test('aborting the signal posts rpc-cancel', async () => {
        const sent: Array<RpcRequest | RpcCancel> = [];
        const client = createRpcClient((msg) => sent.push(msg as RpcRequest | RpcCancel), 1000);
        const controller = new AbortController();

        const promise = client.getProjectsAsync({}, controller.signal);
        controller.abort();
        const result = await promise;

        assert.strictEqual(result.ok, false);
        assert.ok(sent.some((msg) => (msg as RpcCancel).type === 'rpc-cancel'));
    });

    test('RpcHost aborts the handler and suppresses the response on cancel', async () => {
        let receive: (msg: unknown) => Promise<void> = async () => {};
        const posted: unknown[] = [];
        const webview = {
            onDidReceiveMessage: (handler: (msg: unknown) => Promise<void>) => {
                receive = handler;
                return { dispose: () => {} };
            },
            postMessage: async (msg: unknown) => {
                posted.push(msg);
                return true;
            },
        };

        let observedSignal: AbortSignal | undefined;
        const api = {
            getProjectsAsync: async (_req: unknown, signal?: AbortSignal) => {
                observedSignal = signal;
                await new Promise<void>((resolve) => {
                    signal?.addEventListener('abort', () => resolve(), { once: true });
                });
                return { ok: true as const, value: { Projects: [] } };
            },
        } as unknown as HostAPI;

        const host = new RpcHost(webview as never, api);
        const request: RpcRequest = { type: 'rpc-request', id: 7, method: 'getProjectsAsync', params: {} };
        const handling = receive(request);

        receive({ type: 'rpc-cancel', id: 7 });
        await handling;

        assert.strictEqual(observedSignal?.aborted, true);
        assert.deepStrictEqual(posted, []);
        host.dispose();
    });
});
