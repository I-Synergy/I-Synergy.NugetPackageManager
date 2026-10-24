import '../web-setup';
import * as assert from 'assert';
import { UpdatesView } from '@/web/components/updates-view';
import { OutdatedPackageViewModel } from '@/web/types';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { BatchUpdateRequest, HostAPI } from '@/common/rpc/types';

suite('UpdatesView', () => {
    let view: UpdatesView;
    let originalHostApi: HostAPI;
    let captured: BatchUpdateRequest | undefined;

    function makePackage(condition: string, framework: string): OutdatedPackageViewModel {
        return new OutdatedPackageViewModel({
            Id: 'Pkg.Shared',
            InstalledVersion: '1.0.0',
            LatestVersion: '2.0.0',
            Projects: [{ Name: 'A', Path: '/ws/A.csproj', Version: '1.0.0' }],
            SourceUrl: 'https://api.nuget.org/v3/index.json',
            SourceName: 'nuget.org',
            CpmCondition: condition,
            CpmFramework: framework,
        });
    }

    setup(() => {
        originalHostApi = registrations.hostApi;
        captured = undefined;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                batchUpdatePackagesAsync: async (request: BatchUpdateRequest) => {
                    captured = request;
                    return ok({ Results: [{ PackageId: request.Updates[0]!.PackageId, Success: true }] });
                },
                restoreProjectsAsync: async () => ok(undefined),
                updateBadgeAsync: async () => ok(undefined),
            },
            writable: true,
            configurable: true,
        });
        view = new UpdatesView();
    });

    teardown(() => {
        Object.defineProperty(registrations, 'hostApi', {
            value: originalHostApi,
            writable: true,
            configurable: true,
        });
    });

    test('sends the unconditional scope for a shared package row', async () => {
        const pkg = makePackage('', '');
        view.packages = [pkg];

        await (view as unknown as { updateSingleAsync(p: OutdatedPackageViewModel, skip: boolean): Promise<void> })
            .updateSingleAsync(pkg, true);

        assert.strictEqual(captured?.Updates[0]!.Scope, 'unconditional');
        assert.strictEqual(captured?.Updates[0]!.CpmCondition, undefined);
    });

    test('groups visible packages by shared and framework line', () => {
        const shared = makePackage('', '');
        const net8 = makePackage("$(TargetFramework.StartsWith('net8.0'))", 'net8.0');
        const net9 = makePackage("$(TargetFramework.StartsWith('net9.0'))", 'net9.0');
        view.packages = [net9, shared, net8];

        const groups = (view as unknown as {
            groupedVisiblePackages: Array<{ label: string; packages: OutdatedPackageViewModel[] }>;
        }).groupedVisiblePackages;

        assert.deepStrictEqual(groups.map((group) => group.label), ['Shared', 'net8.0', 'net9.0']);
        assert.strictEqual(groups[0]!.packages.length, 1);
    });

    test('sends the group scope and condition for a framework row', async () => {
        const pkg = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        view.packages = [pkg];

        await (view as unknown as { updateSingleAsync(p: OutdatedPackageViewModel, skip: boolean): Promise<void> })
            .updateSingleAsync(pkg, true);

        assert.strictEqual(captured?.Updates[0]!.Scope, 'group');
        assert.strictEqual(captured?.Updates[0]!.CpmCondition, "$(TargetFramework.StartsWith('net10.0'))");
        assert.strictEqual(captured?.Updates[0]!.CpmTfm, 'net10.0');
    });
});
