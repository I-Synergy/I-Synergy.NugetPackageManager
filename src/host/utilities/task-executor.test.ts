import * as assert from 'assert';
import * as sinon from 'sinon';
import { TaskExecutor } from './task-executor';
import { Logger } from '../../common/logger';

suite('TaskExecutor Tests', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'error');
    });

    teardown(() => {
        sandbox.restore();
    });

    test('GetProgress returns null when no operation is active', () => {
        const executor = new TaskExecutor();
        assert.strictEqual(executor.GetProgress('nonexistent'), null);
    });

    test('GetProgress returns null for different unknown operation IDs', () => {
        const executor = new TaskExecutor();
        assert.strictEqual(executor.GetProgress(''), null);
        assert.strictEqual(executor.GetProgress('op-abc'), null);
        assert.strictEqual(executor.GetProgress('0'), null);
    });

    test('ExecuteCommand rejects when dotnet is not found', async () => {
        const executor = new TaskExecutor();
        await assert.rejects(
            () => executor.ExecuteCommandAsync('dotnet-does-not-exist-xyz', [], 'op1'),
            (err: Error) => err instanceof Error
        );
        // Progress is cleaned up after rejection
        assert.strictEqual(executor.GetProgress('op1'), null);
    });
});
