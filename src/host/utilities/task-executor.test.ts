import * as assert from 'assert';
import * as sinon from 'sinon';
import { TaskExecutor } from './task-executor';
import { Logger } from '../../common/logger';
import { EventEmitter } from 'events';

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

    test('ExecuteCommand sets initial progress and resolves on exit code 0', async () => {
        const executor = new TaskExecutor();

        // Spy to capture progress during execution
        let progressDuringRun: import('./task-executor').OperationProgress | null = null;

        // Use a fake spawn that emits exit immediately with code 0
        const spawnModule = await import('child_process');
        const emitter = new EventEmitter() as NodeJS.EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
        };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();

        const spawnStub = sandbox.stub(spawnModule, 'spawn').callsFake(() => {
            progressDuringRun = executor.GetProgress('op1');
            setTimeout(() => (emitter as NodeJS.EventEmitter).emit('exit', 0), 5);
            return emitter as ReturnType<typeof spawnModule.spawn>;
        });

        await executor.ExecuteCommand('dotnet', ['add', 'test.csproj', 'package', 'Newtonsoft.Json'], 'op1');

        assert.ok(spawnStub.calledOnce);
        // During execution the progress was set to "Starting..."
        assert.ok(progressDuringRun !== null);
        assert.strictEqual((progressDuringRun as import('./task-executor').OperationProgress).stage, 'Starting...');
        // After completion, progress is removed
        assert.strictEqual(executor.GetProgress('op1'), null);
    });

    test('ExecuteCommand rejects on non-zero exit code', async () => {
        const executor = new TaskExecutor();
        const spawnModule = await import('child_process');

        const emitter = new EventEmitter() as NodeJS.EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
        };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();

        sandbox.stub(spawnModule, 'spawn').callsFake(() => {
            setTimeout(() => (emitter as NodeJS.EventEmitter).emit('exit', 1), 5);
            return emitter as ReturnType<typeof spawnModule.spawn>;
        });

        await assert.rejects(
            () => executor.ExecuteCommand('dotnet', ['bad-command'], 'op2'),
            /dotnet exited with code 1/
        );
        assert.strictEqual(executor.GetProgress('op2'), null);
    });

    test('ExecuteCommand rejects on process error', async () => {
        const executor = new TaskExecutor();
        const spawnModule = await import('child_process');

        const emitter = new EventEmitter() as NodeJS.EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
        };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();

        sandbox.stub(spawnModule, 'spawn').callsFake(() => {
            setTimeout(() => (emitter as NodeJS.EventEmitter).emit('error', new Error('ENOENT')), 5);
            return emitter as ReturnType<typeof spawnModule.spawn>;
        });

        await assert.rejects(
            () => executor.ExecuteCommand('dotnet', ['test'], 'op3'),
            /ENOENT/
        );
        assert.strictEqual(executor.GetProgress('op3'), null);
    });
});
