import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHostAPI } from './host-api';
import ProjectParser from './utilities/project-parser';
import nugetApiFactory from './nuget/api-factory';
import NuGetConfigResolver from './utilities/nuget-config-resolver';
import CpmResolver from './utilities/cpm-resolver';
import ProjectFrameworkResolver from './utilities/project-framework-resolver';
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

        test('keeps framework-scoped CPM resolutions when package has no single version', async () => {
            const uri = makeProjectUri('/ws/A.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uri]);

            const project = {
                Name: 'A',
                Path: '/ws/A.csproj',
                CpmEnabled: true,
                Packages: [{
                    Id: 'Newtonsoft.Json',
                    Version: '',
                    IsPinned: false,
                    CpmResolutions: [
                        { Tfm: 'net10.0', Version: '1.0.0', Condition: 'net10', ConditionLabel: 'net10.0', Matched: true },
                        { Tfm: 'net11.0', Version: '2.0.0', Condition: 'net11', ConditionLabel: 'net11.0', Matched: true },
                    ],
                }],
            } as unknown as Project;

            sandbox.stub(ProjectParser, 'ParseAsync').resolves(project);
            setupNugetApi('3.0.0');

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 2);
            assert.deepStrictEqual(
                result.value.Packages.map((pkg) => [pkg.CpmFramework, pkg.InstalledVersion]).sort(),
                [['net10.0', '1.0.0'], ['net11.0', '2.0.0']]
            );
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

    test('cleanup ignores projects under .ai scratch directories', async () => {
        const fake = { fsPath: '/ws/.ai/tmp/fakesrc/fake.csproj' } as vscode.Uri;
        const real = { fsPath: '/ws/Real.csproj' } as vscode.Uri;
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: () => undefined,
        } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.workspace, 'findFiles').callsFake(async (pattern: vscode.GlobPattern) =>
            String(pattern).includes('Directory.Packages.props') ? [] : [fake, real]
        );
        const parseStub = sandbox.stub(ProjectParser, 'ParseAsync').callsFake(async (projectPath: string) => {
            if (projectPath === fake.fsPath) throw new Error('invalid content');
            return { Name: 'Real', Path: real.fsPath, Packages: [] } as unknown as Project;
        });

        const api = createHostAPI();
        const result = await api.getCleanupReportAsync({});

        assert.ok(result.ok);
        assert.strictEqual(parseStub.callCount, 1);
        assert.ok(!parseStub.calledWith(fake.fsPath));
    });

    // ----------------------------------------------------------------
    // CPM multi-framework projects
    // ----------------------------------------------------------------
    suite('CPM multi-framework projects', () => {
        let workspaceDir: string;
        let projectsDir: string;

        function fixturesRoot(): string {
            const candidates = [
                path.join(process.cwd(), 'src', 'host', 'utilities', '__fixtures__'),
                path.resolve(__dirname, '..', '..', 'src', 'host', 'utilities', '__fixtures__'),
            ];
            const found = candidates.find((candidate) => fs.existsSync(candidate));
            assert.ok(found, `fixtures directory not found; tried ${candidates.join(', ')}`);
            return found!;
        }

        function projectUris(): vscode.Uri[] {
            return fs.readdirSync(projectsDir)
                .filter((file) => file.endsWith('.csproj'))
                .map((file) => ({ fsPath: path.join(projectsDir, file) }) as vscode.Uri);
        }

        setup(() => {
            workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-cpm-'));
            projectsDir = path.join(workspaceDir, 'projects');
            fs.mkdirSync(projectsDir, { recursive: true });

            fs.writeFileSync(
                path.join(workspaceDir, 'Directory.Packages.props'),
                fs.readFileSync(path.join(fixturesRoot(), 'cpm', 'negated-positive.props'), 'utf8')
            );

            for (const fixture of ['net10', 'net11', 'multi', 'net10-windows']) {
                fs.copyFileSync(
                    path.join(fixturesRoot(), 'projects', fixture, `${fixture}.csproj`),
                    path.join(projectsDir, `${fixture}.csproj`)
                );
            }

            ProjectFrameworkResolver.SetEvaluatorForTests(async (projectPath) => {
                const name = path.basename(projectPath).toLowerCase();
                if (name.startsWith('multi')) return ['net10.0', 'net11.0'];
                if (name.startsWith('net11')) return ['net11.0'];
                if (name.startsWith('net10-windows')) return ['net10.0-windows10.0.26100.0'];
                return ['net10.0'];
            });
        });

        teardown(() => {
            ProjectFrameworkResolver.SetEvaluatorForTests(null);
            ProjectFrameworkResolver.ClearCache();
            fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        });

        test('attaches per-TFM resolutions to each project variant', async () => {
            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async (pattern: vscode.GlobPattern) =>
                String(pattern).includes('sln') ? [] : projectUris()
            );

            const api = createHostAPI();
            const result = await api.getProjectsAsync({ ForceReload: false });
            assert.ok(result.ok);

            const byName = new Map(result.value.Projects.map((project) => [project.Name, project]));

            const net10 = byName.get('net10.csproj')!;
            assert.deepStrictEqual(net10.TargetFrameworks, ['net10.0']);
            const loggingNet10 = net10.Packages.find((pkg) => pkg.Id === 'Microsoft.Extensions.Logging')!;
            assert.deepStrictEqual(loggingNet10.CpmResolutions, [{
                PackageId: 'Microsoft.Extensions.Logging',
                Tfm: 'net10.0',
                Version: '10.0.13',
                Condition: "!$(TargetFramework.StartsWith('net11.0'))",
                ConditionLabel: 'not net11.0',
                Matched: true,
            }]);

            const net11 = byName.get('net11.csproj')!;
            const loggingNet11 = net11.Packages.find((pkg) => pkg.Id === 'Microsoft.Extensions.Logging')!;
            assert.strictEqual(loggingNet11.CpmResolutions!.length, 1);
            assert.strictEqual(loggingNet11.CpmResolutions![0]!.Tfm, 'net11.0');
            assert.strictEqual(loggingNet11.CpmResolutions![0]!.Version, '11.0.0-rc.2.26504.105');

            const multi = byName.get('multi.csproj')!;
            assert.deepStrictEqual(multi.TargetFrameworks, ['net10.0', 'net11.0']);
            const loggingMulti = multi.Packages.find((pkg) => pkg.Id === 'Microsoft.Extensions.Logging')!;
            assert.strictEqual(loggingMulti.CpmResolutions!.length, 2);
            assert.strictEqual(
                loggingMulti.CpmResolutions!.find((r) => r.Tfm === 'net10.0')!.Version,
                '10.0.13'
            );
            assert.strictEqual(
                loggingMulti.CpmResolutions!.find((r) => r.Tfm === 'net11.0')!.Version,
                '11.0.0-rc.2.26504.105'
            );

            const windows = byName.get('net10-windows.csproj')!;
            const loggingWindows = windows.Packages.find((pkg) => pkg.Id === 'Microsoft.Extensions.Logging')!;
            assert.strictEqual(loggingWindows.CpmResolutions!.length, 1);
            assert.strictEqual(loggingWindows.CpmResolutions![0]!.Tfm, 'net10.0-windows10.0.26100.0');
            assert.strictEqual(loggingWindows.CpmResolutions![0]!.Version, '10.0.13');

            const shared = multi.Packages.find((pkg) => pkg.Id === 'Shared.Library')!;
            assert.strictEqual(shared.CpmResolutions!.length, 1);
            assert.strictEqual(shared.CpmResolutions![0]!.Tfm, '');
            assert.strictEqual(shared.CpmResolutions![0]!.Version, '1.0.0');
        });

        test('keeps framework lines separate when grouping inconsistencies', async () => {
            const projects = [
                { name: 'net10-a', condition: "net", tfm: 'net10.0', version: '1.0.0' },
                { name: 'net10-b', condition: "net", tfm: 'net10.0', version: '1.1.0' },
                { name: 'net11-a', condition: "net", tfm: 'net11.0', version: '2.0.0' },
            ];
            const uris = projects.map((p) => ({ fsPath: `/ws/${p.name}.csproj` }) as vscode.Uri);

            sandbox.stub(vscode.workspace, 'findFiles').resolves(uris);
            sandbox.stub(CpmResolver, 'FindCpmFilePathAsync').resolves(null);
            sandbox.stub(ProjectParser, 'ParseAsync').callsFake(async (projectPath: string) => {
                const name = path.basename(projectPath, '.csproj');
                const fixture = projects.find((p) => p.name === name)!;
                return {
                    Path: projectPath,
                    Name: fixture.name,
                    CpmEnabled: true,
                    Packages: [{
                        Id: 'Pkg.Line',
                        Version: fixture.version,
                        IsPinned: false,
                        VersionSource: 'central',
                        CpmResolutions: [{
                            Tfm: fixture.tfm,
                            Version: fixture.version,
                            Condition: fixture.condition,
                            ConditionLabel: fixture.condition,
                            Matched: true,
                        }],
                    }],
                } as Project;
            });

            const configStub = { get: sandbox.stub() };
            configStub.get.withArgs('excludeGlobs').returns([]);
            configStub.get.withArgs('extraTargetFrameworks').returns([]);
            configStub.get.withArgs('frameworkAlignedPackages').returns([]);
            sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);

            const api = createHostAPI();
            const result = await api.getInconsistentPackagesAsync({});
            assert.ok(result.ok);

            const inconsistent = result.value.Packages.find((pkg) => pkg.Id === 'Pkg.Line');
            assert.ok(inconsistent, 'the net10 line is inconsistent');
            assert.strictEqual(inconsistent!.Versions.length, 2);
            assert.ok(
                inconsistent!.Versions.every((version) => version.CpmFramework === 'net10.0'),
                'the net11 line must not be merged into the net10 card'
            );
        });

        test('reports one outdated row per TFM with version-aligned latest', async () => {
            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async (pattern: vscode.GlobPattern) =>
                String(pattern).includes('sln') ? [] : projectUris()
            );
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);

            const mockApi = {
                GetPackagesAsync: sandbox.stub().resolves({
                    data: [{
                        Name: 'Microsoft.Extensions.Logging',
                        Id: 'Microsoft.Extensions.Logging',
                        Version: '11.0.0-rc.3',
                        Versions: [
                            { Version: '10.0.14', Id: '' },
                            { Version: '11.0.0-rc.3', Id: '' },
                        ],
                    }],
                }),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: true });
            assert.ok(result.ok);

            const loggingRows = result.value.Packages.filter(
                (pkg) => pkg.Id === 'Microsoft.Extensions.Logging'
            );
            assert.strictEqual(loggingRows.length, 2, 'one row per framework line');

            const net10Row = loggingRows.find((pkg) => pkg.CpmFramework === 'net10.0')!;
            assert.ok(net10Row);
            assert.strictEqual(net10Row.InstalledVersion, '10.0.13');
            assert.strictEqual(net10Row.LatestVersion, '10.0.14', 'stays on the net10 major line');
            assert.strictEqual(net10Row.LatestOverallVersion, '11.0.0-rc.3');
            assert.strictEqual(net10Row.CpmConditionLabel, 'not net11.0');

            const net11Row = loggingRows.find((pkg) => pkg.CpmFramework === 'net11.0')!;
            assert.ok(net11Row);
            assert.strictEqual(net11Row.InstalledVersion, '11.0.0-rc.2.26504.105');
            assert.strictEqual(net11Row.LatestVersion, '11.0.0-rc.3');
            assert.strictEqual(net11Row.LatestOverallVersion, undefined);
        });
    });

    // ----------------------------------------------------------------
    // CPM write scope
    // ----------------------------------------------------------------
    suite('CPM write scope', () => {
        let workspaceDir: string;
        let projectPath: string;

        function fixturesRoot(): string {
            const candidates = [
                path.join(process.cwd(), 'src', 'host', 'utilities', '__fixtures__'),
                path.resolve(__dirname, '..', '..', 'src', 'host', 'utilities', '__fixtures__'),
            ];
            const found = candidates.find((candidate) => fs.existsSync(candidate));
            assert.ok(found, `fixtures directory not found; tried ${candidates.join(', ')}`);
            return found!;
        }

        function setupWorkspace(fixture: string): void {
            workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-cpm-write-'));
            fs.writeFileSync(
                path.join(workspaceDir, 'Directory.Packages.props'),
                fs.readFileSync(path.join(fixturesRoot(), 'cpm', fixture), 'utf8')
            );
            projectPath = path.join(workspaceDir, 'App.csproj');
            fs.writeFileSync(
                projectPath,
                '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageReference Include="Pkg.Shared" /><PackageReference Include="Microsoft.Extensions.Logging" /></ItemGroup></Project>'
            );

            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceDir } }]);
        }

        teardown(() => {
            ProjectFrameworkResolver.SetEvaluatorForTests(null);
            if (workspaceDir) {
                fs.rmSync(workspaceDir, { recursive: true, force: true });
            }
        });

        test('unconditional scope leaves conditional framework lines untouched', async () => {
            setupWorkspace('unconditional-plus-conditional.props');

            const api = createHostAPI();
            const result = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
            });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Results[0]!.Success, true);

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            assert.strictEqual(map.unconditional.get('Pkg.Shared'), '1.5.0');
            assert.strictEqual(
                map.conditional.find((entry) => entry.framework === 'net10.0')!.versions.get('Pkg.Shared'),
                '2.0.0'
            );
        });

        test('consolidates only the requested framework line', async () => {
            setupWorkspace('negated-positive.props');

            const configStub = { get: sandbox.stub() };
            configStub.get.withArgs('skipRestore').returns('true');
            sandbox.stub(vscode.workspace, 'getConfiguration').returns(
                configStub as unknown as vscode.WorkspaceConfiguration
            );

            const api = createHostAPI();
            const result = await api.consolidatePackagesAsync({
                PackageId: 'Microsoft.Extensions.Logging',
                TargetVersion: '10.0.14',
                ProjectPaths: [projectPath],
                CpmCondition: "!$(TargetFramework.StartsWith('net11.0'))",
                Scope: 'group',
            });

            assert.ok(result.ok, result.ok ? '' : result.error);

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            const net10 = map.conditional.find((entry) => entry.condition.startsWith('!'))!;
            const net11 = map.conditional.find((entry) => !entry.condition.startsWith('!'))!;
            assert.strictEqual(net10.versions.get('Microsoft.Extensions.Logging'), '10.0.14');
            assert.strictEqual(net11.versions.get('Microsoft.Extensions.Logging'), '11.0.0-rc.2.26504.105');
        });

        test('refuses a blanket consolidation of a framework-scoped package', async () => {
            setupWorkspace('negated-positive.props');

            const configStub = { get: sandbox.stub() };
            configStub.get.withArgs('skipRestore').returns('true');
            sandbox.stub(vscode.workspace, 'getConfiguration').returns(
                configStub as unknown as vscode.WorkspaceConfiguration
            );

            const api = createHostAPI();
            const result = await api.consolidatePackagesAsync({
                PackageId: 'Microsoft.Extensions.Logging',
                TargetVersion: '10.0.14',
                ProjectPaths: [projectPath],
                Scope: 'all',
            });

            assert.strictEqual(result.ok, false);
            if (!result.ok) {
                assert.match(result.error, /framework-scoped versions/);
            }

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            const net10 = map.conditional.find((entry) => entry.condition.startsWith('!'))!;
            const net11 = map.conditional.find((entry) => !entry.condition.startsWith('!'))!;
            assert.strictEqual(net10.versions.get('Microsoft.Extensions.Logging'), '10.0.13');
            assert.strictEqual(net11.versions.get('Microsoft.Extensions.Logging'), '11.0.0-rc.2.26504.105');
        });

        test('refuses an ambiguous multi-framework update without a condition', async () => {
            setupWorkspace('shared-id-positive-groups.props');

            const api = createHostAPI();
            const result = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Microsoft.Extensions.Http',
                    Version: '9.0.2',
                    ProjectPaths: [projectPath],
                }],
            });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Results[0]!.Success, false);
            assert.match(result.value.Results[0]!.Error ?? '', /multiple framework-scoped versions/);
        });

        test('rejects update and restore paths outside the workspace', async () => {
            setupWorkspace('single-group.props');
            const outside = path.join(workspaceDir, '..', 'Evil.csproj');

            const api = createHostAPI();
            const update = await api.updateProjectAsync({
                ProjectPath: outside,
                PackageId: 'Newtonsoft.Json',
                Version: '13.0.3',
                Type: 'UPDATE',
            });
            assert.strictEqual(update.ok, false);

            const restore = await api.restoreProjectsAsync({ ProjectPaths: [outside] });
            assert.strictEqual(restore.ok, false);

            const batch = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Newtonsoft.Json',
                    Version: '13.0.3',
                    ProjectPaths: [outside],
                }],
            });
            assert.strictEqual(batch.ok, false);
        });

        test('rejects invalid package IDs and versions before writing', async () => {
            setupWorkspace('single-group.props');
            const api = createHostAPI();

            const badId = await api.updateProjectAsync({
                ProjectPath: projectPath,
                PackageId: 'Evil" /><PackageVersion Include="X',
                Version: '1.0.0',
                Type: 'UPDATE',
            });
            assert.strictEqual(badId.ok, false);

            const badVersion = await api.updateProjectAsync({
                ProjectPath: projectPath,
                PackageId: 'Pkg.Shared',
                Version: '1.0.0" /><Import Project="evil.props"',
                Type: 'UPDATE',
            });
            assert.strictEqual(badVersion.ok, false);
        });

        test('matches vulnerabilities case-insensitively and returns the original package ID', async () => {
            setupWorkspace('negated-positive.props');
            ProjectFrameworkResolver.SetEvaluatorForTests(async () => ['net10.0']);

            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async (pattern: vscode.GlobPattern) =>
                String(pattern).includes('sln') ? [] : [{ fsPath: projectPath }] as vscode.Uri[]
            );
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves({
                GetVulnerabilitiesAsync: async () => new Map([
                    ['MICROSOFT.EXTENSIONS.LOGGING', [{
                        url: 'https://advisory.example/1',
                        severity: 3,
                        versions: '[0.0.0, )',
                    }]],
                ]),
            } as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getVulnerablePackagesAsync({ ForceReload: false });

            assert.ok(result.ok);
            const row = result.value.Packages.find((pkg) => pkg.Id === 'Microsoft.Extensions.Logging');
            assert.ok(row, 'the original package ID must be preserved');
            assert.strictEqual(row!.InstalledVersion, '10.0.13');
            assert.deepStrictEqual(row!.CpmFrameworks, ['net10.0']);
        });
    });
});
