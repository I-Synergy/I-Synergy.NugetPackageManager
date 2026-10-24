import '../web-setup';
import * as assert from 'assert';
import { CleanupView } from '@/web/components/cleanup-view';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { HostAPI } from '@/common/rpc/types';

suite('CleanupView Component', () => {
    let view: CleanupView;
    let originalHostApi: HostAPI;
    let cleanupCalls = 0;

    const report = {
        PropsFiles: [{
            Path: '/ws/Directory.Packages.props',
            Defined: ['Used.Package', 'Unused.One', 'Unused.Two'],
            Unused: ['Unused.One', 'Unused.Two'],
        }],
        Used: ['Used.Package'],
        Missing: [],
        Unused: ['Unused.One', 'Unused.Two'],
    };

    setup(() => {
        cleanupCalls = 0;
        originalHostApi = registrations.hostApi;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => ok(report),
                cleanupUnusedPackagesAsync: async () => {
                    cleanupCalls++;
                    return ok({
                        Report: { ...report, PropsFiles: [{ ...report.PropsFiles[0]!, Unused: [] }], Unused: [] },
                        Removed: ['Unused.One', 'Unused.Two'],
                        Backups: ['/ws/Directory.Packages.props.backup.test'],
                        Errors: [],
                    });
                },
                showConfirmationAsync: async () => ok({ Confirmed: true }),
            },
            writable: true,
            configurable: true,
        });
        view = new CleanupView();
        document.body.appendChild(view);
    });

    teardown(() => {
        document.body.removeChild(view);
        Object.defineProperty(registrations, 'hostApi', {
            value: originalHostApi,
            writable: true,
            configurable: true,
        });
    });

    test('renders unused packages grouped by props file', async () => {
        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const rows = view.shadowRoot?.querySelectorAll('.unused-row');
        assert.strictEqual(rows?.length, 2);
        assert.ok(view.shadowRoot?.textContent?.includes('Unused.One'));
        assert.ok(view.shadowRoot?.textContent?.includes('Unused.Two'));
    });

    test('removes unused packages and emits completion', async () => {
        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        let completed = false;
        view.addEventListener('cleanup-completed', () => { completed = true; });
        const button = [...(view.shadowRoot?.querySelectorAll('button') ?? [])]
            .find((candidate) => candidate.textContent?.includes('Remove unused'));
        assert.ok(button, 'Remove unused button should be present');
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await view.updateComplete;

        assert.strictEqual(cleanupCalls, 1);
        assert.strictEqual(completed, true);
        assert.ok(view.shadowRoot?.textContent?.includes('backup'));
    });
});
