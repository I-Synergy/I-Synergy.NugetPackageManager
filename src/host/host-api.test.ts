import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { createHostAPI } from './host-api';
import ProjectParser from './utilities/project-parser';
import nugetApiFactory from './nuget/api-factory';
import NuGetConfigResolver from './utilities/nuget-config-resolver';
import CpmResolver from './utilities/cpm-resolver';
import TaskExecutorDefault from './utilities/task-executor';
import { Logger } from '../common/logger';

suite('HostAPI Tests', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'warn');
        sandbox.stub(Logger, 'error');
    });

    teardown(() => {
        sandbox.restore();
    });

    // ----------------------------------------------------------------
    // getProjects
    // ----------------------------------------------------------------
    suite('getProjects', () => {
        test('returns sorted projects on success', async () => {
            const projectUri = { fsPath: '/ws/MyApp/MyApp.csproj' } as vscode.Uri;
            sandbox.stub(vscode.workspace, 'findFiles').resolves([projectUri]);
            sandbox.stub(ProjectParser, 'ParseAsync').resolves({
                Name: 'MyApp',
                Path: '/ws/MyApp/MyApp.csproj',
                Packages: [],
                CpmEnabled: false,
            } as Project);

            const api = createHostAPI();
            const result = await api.getProjectsAsync({ ForceReload: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Projects.length, 1);
            assert.strictEqual(result.value.Projects[0]!.Name, 'MyApp');
        });

        test('returns empty Projects when no project files found', async () => {
            sandbox.stub(vscode.workspace, 'findFiles').resolves([]);

            const api = createHostAPI();
            const result = await api.getProjectsAsync({});

            assert.ok(result.ok);
            assert.deepStrictEqual(result.value.Projects, []);
        });

        test('skips projects that fail to parse', async () => {
            const uri1 = { fsPath: '/ws/A.csproj' } as vscode.Uri;
            const uri2 = { fsPath: '/ws/B.csproj' } as vscode.Uri;
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uri1, uri2]);

            const parseStub = sandbox.stub(ProjectParser, 'ParseAsync');
            parseStub.onFirstCall().resolves({ Name: 'A', Path: '/ws/A.csproj', Packages: [], CpmEnabled: false } as Project);
            parseStub.onSecondCall().rejects(new Error('parse failed'));

            const api = createHostAPI();
            const result = await api.getProjectsAsync({});

            assert.ok(result.ok);
            assert.strictEqual(result.value.Projects.length, 1);
            assert.strictEqual(result.value.Projects[0]!.Name, 'A');
        });
    });

    // ----------------------------------------------------------------
    // getConfiguration
    // ----------------------------------------------------------------
    suite('getConfiguration', () => {
        test('returns configuration with sources', async () => {
            const configStub = {
                get: sandbox.stub(),
            };
            configStub.get.withArgs('skipRestore').returns(false);
            configStub.get.withArgs('enablePackageVersionInlineInfo').returns(false);
            configStub.get.withArgs('prerelease').returns(false);
            configStub.get.withArgs('statusBarLoadingIndicator').returns(false);
            configStub.get.withArgs('sources').returns([]);

            sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);

            const api = createHostAPI();
            const result = await api.getConfigurationAsync();

            assert.ok(result.ok);
            assert.strictEqual(result.value.Configuration.Sources.length, 1);
            assert.strictEqual(result.value.Configuration.Sources[0]!.Name, 'nuget.org');
            assert.strictEqual(result.value.Configuration.SkipRestore, false);
        });

        test('returns configuration with empty sources when none configured', async () => {
            const configStub = { get: sandbox.stub() };
            configStub.get.returns(false);
            configStub.get.withArgs('sources').returns([]);

            sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);
            sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([]);

            const api = createHostAPI();
            const result = await api.getConfigurationAsync();

            assert.ok(result.ok);
            assert.deepStrictEqual(result.value.Configuration.Sources, []);
        });
    });

    // ----------------------------------------------------------------
    // getOperationProgress
    // ----------------------------------------------------------------
    suite('getOperationProgress', () => {
        test('returns Active=false when no operation is running', async () => {
            sandbox.stub(TaskExecutorDefault, 'GetProgress').returns(null);

            const api = createHostAPI();
            const result = await api.getOperationProgressAsync({ OperationId: 'op-123' });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Active, false);
            assert.strictEqual(result.value.Percent, 0);
            assert.strictEqual(result.value.Stage, '');
        });

        test('returns Active=true with stage and percent when operation running', async () => {
            sandbox.stub(TaskExecutorDefault, 'GetProgress').returns({ stage: 'Resolving...', percent: 20 });

            const api = createHostAPI();
            const result = await api.getOperationProgressAsync({ OperationId: 'op-456' });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Active, true);
            assert.strictEqual(result.value.Stage, 'Resolving...');
            assert.strictEqual(result.value.Percent, 20);
        });
    });

    // ----------------------------------------------------------------
    // showConfirmation
    // ----------------------------------------------------------------
    suite('showConfirmation', () => {
        test('returns Confirmed=true when user clicks Yes', async () => {
            sandbox.stub(vscode.window, 'showWarningMessage').resolves('Yes' as unknown as vscode.MessageItem);

            const api = createHostAPI();
            const result = await api.showConfirmationAsync({ Message: 'Are you sure?' });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Confirmed, true);
        });

        test('returns Confirmed=false when user dismisses dialog', async () => {
            sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

            const api = createHostAPI();
            const result = await api.showConfirmationAsync({ Message: 'Are you sure?' });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Confirmed, false);
        });
    });

    // ----------------------------------------------------------------
    // getPackages — error path
    // ----------------------------------------------------------------
    suite('getPackages', () => {
        test('returns fail result when API throws', async () => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
            const mockApi = {
                GetPackagesAsync: sandbox.stub().rejects(new Error('Network error')),
                ClearPackageCache: sandbox.stub(),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getPackagesAsync({
                Url: 'https://api.nuget.org/v3/index.json',
                Filter: 'Newtonsoft',
                Prerelease: false,
                Skip: 0,
                Take: 20,
            });

            assert.ok(!result.ok);
            assert.ok(result.error.includes('Network error'));
        });

        test('returns packages on success', async () => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([]);
            const mockApi = {
                GetPackagesAsync: sandbox.stub().resolves({ data: [{ Id: 'Newtonsoft.Json', Name: 'Newtonsoft.Json', Version: '13.0.1' }] }),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getPackagesAsync({
                Url: 'https://api.nuget.org/v3/index.json',
                Filter: 'Newtonsoft',
                Prerelease: false,
                Skip: 0,
                Take: 20,
            });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 1);
            assert.strictEqual(result.value.Packages[0]!.Id, 'Newtonsoft.Json');
        });
    });

    // ----------------------------------------------------------------
    // getOutdatedPackages
    // ----------------------------------------------------------------
    suite('getOutdatedPackages', () => {
        function makeProjectUri(fsPath: string): vscode.Uri {
            return { fsPath } as vscode.Uri;
        }

        function makeProject(name: string, pkgPath: string, pkgVersion: string): Project {
            return {
                Name: name,
                Path: pkgPath,
                CpmEnabled: false,
                Packages: [{ Id: 'Newtonsoft.Json', Version: pkgVersion, IsPinned: false }],
            } as unknown as Project;
        }

        function setupNugetApi(latestVersion: string) {
            const mockApi = {
                GetPackagesAsync: sandbox.stub().resolves({
                    data: [{ Name: 'Newtonsoft.Json', Id: 'Newtonsoft.Json', Version: latestVersion }],
                }),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );
        }

        setup(() => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
            // No CPM for these tests
            sandbox.stub(CpmResolver, 'GetPackageVersionsAsync').resolves(null);
        });

        test('reports package as outdated when one project is behind latest (min-version aggregation)', async () => {
            // Project A has 1.0.0, Project B has 2.0.0, latest is 2.0.0.
            // With min-version tracking the entry version should be 1.0.0, which IS older than 2.0.0.
            const uriA = makeProjectUri('/ws/A.csproj');
            const uriB = makeProjectUri('/ws/B.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uriA, uriB]);

            const parseStub = sandbox.stub(ProjectParser, 'ParseAsync');
            parseStub.onFirstCall().resolves(makeProject('A', '/ws/A.csproj', '1.0.0'));
            parseStub.onSecondCall().resolves(makeProject('B', '/ws/B.csproj', '2.0.0'));

            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 1);
            assert.strictEqual(result.value.Packages[0]!.Id, 'Newtonsoft.Json');
            assert.strictEqual(result.value.Packages[0]!.InstalledVersion, '1.0.0');
            assert.strictEqual(result.value.Packages[0]!.LatestVersion, '2.0.0');
            assert.strictEqual(result.value.Packages[0]!.Projects.length, 2);
        });

        test('does not report package as outdated when all projects are already at latest', async () => {
            const uriA = makeProjectUri('/ws/A.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uriA]);

            const parseStub = sandbox.stub(ProjectParser, 'ParseAsync');
            parseStub.resolves(makeProject('A', '/ws/A.csproj', '2.0.0'));

            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 0);
        });

        test('reports package as outdated when installed version is prerelease and latest is stable', async () => {
            // 1.0.0-beta should be treated as less than 1.0.0 (NuGet SemVer)
            const uri = makeProjectUri('/ws/A.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uri]);

            const parseStub = sandbox.stub(ProjectParser, 'ParseAsync');
            parseStub.resolves(makeProject('A', '/ws/A.csproj', '1.0.0-beta'));

            setupNugetApi('1.0.0');

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 1);
            assert.strictEqual(result.value.Packages[0]!.InstalledVersion, '1.0.0-beta');
            assert.strictEqual(result.value.Packages[0]!.LatestVersion, '1.0.0');
        });
    });
});
