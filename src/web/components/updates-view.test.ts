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

    test('includes installed framework lines even when they have no outdated row', () => {
        const net10 = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        view.packages = [net10];
        view.availableFrameworks = [
            { value: '', label: 'All frameworks' },
            { value: 'net10.0', label: 'net10.0' },
            { value: 'net11.0', label: 'net11.0' },
        ];

        assert.deepStrictEqual(view.frameworkOptions, [
            { value: '', label: 'All frameworks' },
            { value: 'net10.0', label: 'net10.0' },
            { value: 'net11.0', label: 'net11.0' },
        ]);
    });

    test('exposes framework options and filters visible updates by framework', () => {
        const shared = makePackage('', '');
        const net10 = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        const net11 = makePackage("$(TargetFramework.StartsWith('net11.0'))", 'net11.0');
        view.packages = [shared, net11, net10];

        assert.deepStrictEqual(view.frameworkOptions, [
            { value: '', label: 'All frameworks' },
            { value: '__shared__', label: 'Shared' },
            { value: 'net10.0', label: 'net10.0' },
            { value: 'net11.0', label: 'net11.0' },
        ]);

        view.selectedFramework = 'net11.0';
        const visible = (view as unknown as { visiblePackages: OutdatedPackageViewModel[] }).visiblePackages;
        assert.deepStrictEqual(visible.map((pkg) => pkg.CpmFramework).sort(), ['net11.0']);

        view.selectedFramework = '__shared__';
        const sharedOnly = (view as unknown as { visiblePackages: OutdatedPackageViewModel[] }).visiblePackages;
        assert.deepStrictEqual(sharedOnly.map((pkg) => pkg.CpmFramework), ['']);
    });

    test('does not duplicate the shared option from available frameworks', () => {
        const shared = makePackage('', '');
        view.packages = [shared];
        view.availableFrameworks = [
            { value: '', label: 'All frameworks' },
            { value: '__shared__', label: 'Shared' },
            { value: 'net10.0', label: 'net10.0' },
        ];

        assert.deepStrictEqual(view.frameworkOptions, [
            { value: '', label: 'All frameworks' },
            { value: '__shared__', label: 'Shared' },
            { value: 'net10.0', label: 'net10.0' },
        ]);
    });

    test('collapses platform TFMs into their base .NET line', () => {
        const windows = makePackage("$(TargetFramework.Contains('-windows'))", 'net10.0-windows10.0.26100.0');
        const android = makePackage("$(TargetFramework.Contains('-android'))", 'net10.0-android34.0');
        view.packages = [windows, android];

        assert.deepStrictEqual(view.frameworkOptions, [
            { value: '', label: 'All frameworks' },
            { value: 'net10.0', label: 'net10.0' },
        ]);

        view.selectedFramework = 'net10.0';
        const visible = (view as unknown as { visiblePackages: OutdatedPackageViewModel[] }).visiblePackages;
        assert.strictEqual(visible.length, 2);
    });

    test('selects and deselects all visible packages in a group', () => {
        const sharedA = makePackage('', '');
        const sharedB = makePackage('', '');
        const net10 = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        view.packages = [sharedA, sharedB, net10];
        view.selectedFramework = '';

        const groups = (view as unknown as {
            groupedVisiblePackages: Array<{ label: string; packages: OutdatedPackageViewModel[] }>;
        }).groupedVisiblePackages;
        const sharedGroup = groups.find((group) => group.label === 'Shared')!;
        const toggle = (view as unknown as {
            toggleGroupSelection(packages: OutdatedPackageViewModel[], selected: boolean): void;
        }).toggleGroupSelection.bind(view);

        toggle(sharedGroup.packages, true);
        assert.ok(sharedA.Selected && sharedB.Selected);
        assert.strictEqual(net10.Selected, false);

        toggle(sharedGroup.packages, false);
        assert.strictEqual(sharedA.Selected, false);
        assert.strictEqual(sharedB.Selected, false);
        assert.strictEqual(net10.Selected, false);
    });

    test('emits packages-updated after a successful update', async () => {
        const pkg = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        view.packages = [pkg];
        let events = 0;
        view.addEventListener('packages-updated', () => { events++; });

        const succeeded = await (view as unknown as {
            updateSingleAsync(p: OutdatedPackageViewModel, skip: boolean): Promise<boolean>;
        }).updateSingleAsync(pkg, true);

        assert.strictEqual(succeeded, true);
        assert.strictEqual(events, 1);
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
