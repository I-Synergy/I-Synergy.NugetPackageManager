import '../web-setup';
import * as assert from 'assert';
import { render, type TemplateResult } from 'lit';
import { UpdatesView } from '@/web/components/updates-view';
import { OutdatedPackageViewModel } from '@/web/types';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { BatchUpdateRequest, GetOutdatedPackagesRequest, HostAPI } from '@/common/rpc/types';

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
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
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

    test('renders the pinning dependency for a held-back update', () => {
        const pkg = makePackage('', '');
        pkg.LatestOverallVersion = '3.0.0';
        const blockedBy = [{
            PackageId: 'Npgsql.EntityFrameworkCore.PostgreSQL',
            InstalledVersion: '11.0.0-rc.2',
            Range: '[11.0.0-rc.2.26504.105]',
        }];
        pkg.BlockedBy = blockedBy;
        view.packages = [pkg];
        view.blockedPackages = [{
            Id: 'Microsoft.EntityFrameworkCore.Relational',
            InstalledVersion: '11.0.0-rc.2.26504.105',
            BlockedVersion: '11.0.0-rc.3.26522.148',
            Reason: pkg.blockedReason,
            BlockedBy: blockedBy,
        }];

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);

        assert.strictEqual(host.querySelectorAll('.conflict-row').length, 1);
        assert.match(host.textContent ?? '', /Dependency conflicts \(1\)/);
        assert.match(host.textContent ?? '', /11\.0\.0-rc\.2\.26504\.105 → 11\.0\.0-rc\.3\.26522\.148 blocked/);
        assert.match(host.textContent ?? '', /Npgsql\.EntityFrameworkCore\.PostgreSQL 11\.0\.0-rc\.2 requires \[11\.0\.0-rc\.2\.26504\.105\]/);
    });

    test('does not claim everything is up to date when every update is blocked', () => {
        const blockedBy = [{
            PackageId: 'Npgsql.EntityFrameworkCore.PostgreSQL',
            InstalledVersion: '11.0.0-rc.2',
            Range: '[11.0.0-rc.2.26504.105]',
        }];
        view.packages = [];
        view.blockedPackages = [{
            Id: 'Microsoft.EntityFrameworkCore.Relational',
            InstalledVersion: '11.0.0-rc.2.26504.105',
            BlockedVersion: '11.0.0-rc.3.26522.148',
            Reason: 'Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 requires [11.0.0-rc.2.26504.105]',
            BlockedBy: blockedBy,
        }];

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);

        assert.doesNotMatch(host.textContent ?? '', /All packages are up to date/);
        assert.match(host.textContent ?? '', /Dependency conflicts \(1\)/);
    });

    test('paints cached rows and preserves selections across the refresh', () => {
        const raw = {
            Id: 'Pkg.Shared',
            InstalledVersion: '1.0.0',
            LatestVersion: '2.0.0',
            Projects: [{ Name: 'A', Path: '/ws/A.csproj', Version: '1.0.0' }],
            SourceUrl: 'https://api.nuget.org/v3/index.json',
            SourceName: 'nuget.org',
        };

        (view as unknown as {
            applyScan(response: { Packages: typeof raw[]; FromCache?: boolean; ScannedAt?: string }, fromCache: boolean): void;
        }).applyScan({ Packages: [raw], FromCache: true, ScannedAt: '2026-10-26T12:00:00.000Z' }, true);

        assert.strictEqual(view.packages.length, 1);
        assert.strictEqual(view.isRefreshing, true);
        assert.match(view.statusText, /cached results/);

        view.packages[0]!.Selected = false;
        (view as unknown as {
            applyScan(response: { Packages: typeof raw[]; FromCache?: boolean }, fromCache: boolean): void;
        }).applyScan({ Packages: [raw], FromCache: false }, false);

        assert.strictEqual(view.packages[0]!.Selected, false);
        assert.strictEqual(view.isRefreshing, false);
        assert.strictEqual(view.statusText, '');
    });

    test('requests the cached scan before the live scan', async () => {
        const requests: boolean[] = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getOutdatedPackagesAsync: async (request: GetOutdatedPackagesRequest) => {
                    requests.push(request.PreferCache === true);
                    return ok({ Packages: [], FromCache: request.PreferCache === true });
                },
                batchUpdatePackagesAsync: async () => ok({ Results: [] }),
                restoreProjectsAsync: async () => ok(undefined),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadOutdatedPackagesAsync();

        assert.deepStrictEqual(requests, [true, false]);
    });

    test('emits the tree badge payload with the blocked count', () => {
        const emitted: Array<{ Count: number; BlockedCount: number }> = [];
        view.addEventListener('badge-changed', (e) => {
            emitted.push((e as CustomEvent<{ Count: number; BlockedCount: number }>).detail);
        });

        const raw = {
            Id: 'Pkg.Shared',
            InstalledVersion: '1.0.0',
            LatestVersion: '2.0.0',
            Projects: [{ Name: 'A', Path: '/ws/A.csproj', Version: '1.0.0' }],
            SourceUrl: 'https://api.nuget.org/v3/index.json',
            SourceName: 'nuget.org',
        };

        (view as unknown as {
            applyScan(response: unknown, fromCache: boolean): void;
        }).applyScan({
            Packages: [raw],
            BlockedPackages: [{
                Id: 'Blocked.Package',
                InstalledVersion: '1.0.0',
                BlockedVersion: '2.0.0',
                Reason: 'pinned',
                BlockedBy: [{ PackageId: 'Pinned.Package', InstalledVersion: '1.0.0', Range: '[1.0.0]' }],
            }],
        }, false);

        assert.deepStrictEqual(emitted, [{ Count: 1, BlockedCount: 1 }]);
    });

    test('updates the visible stage and counts from the scan progress RPC', async () => {
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getOutdatedScanProgressAsync: async () => ok({
                    Stage: 'Checking latest versions (3/10)…',
                    Percent: 48,
                    Completed: 3,
                    Total: 10,
                    Active: true,
                }),
            },
            writable: true,
            configurable: true,
        });

        (view as unknown as { _activeScanId: string })._activeScanId = 'scan-1';
        await (view as unknown as { refreshScanProgressAsync(id: string): Promise<void> })
            .refreshScanProgressAsync('scan-1');

        assert.deepStrictEqual(view.scanProgress, {
            Stage: 'Checking latest versions (3/10)…',
            Percent: 48,
            Completed: 3,
            Total: 10,
        });
    });

    test('ignores progress reported for a superseded scan', async () => {
        let polled = false;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getOutdatedScanProgressAsync: async () => {
                    polled = true;
                    return ok({ Stage: 'stale', Percent: 60, Completed: 6, Total: 10, Active: true });
                },
            },
            writable: true,
            configurable: true,
        });

        (view as unknown as { _activeScanId: string })._activeScanId = 'scan-2';
        await (view as unknown as { refreshScanProgressAsync(id: string): Promise<void> })
            .refreshScanProgressAsync('scan-1');

        assert.strictEqual(polled, false);
        assert.strictEqual(view.scanProgress, null);
    });
});
