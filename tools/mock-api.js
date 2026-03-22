/**
 * Mock acquireVsCodeApi() for the dev server / screenshot harness.
 *
 * Project references (which projects exist and which packages are installed
 * in each) are mocked locally. All NuGet package data — search results,
 * available versions, updates, and vulnerabilities — is fetched live from
 * nuget.org via the dev server's /nuget-proxy endpoint.
 */
(function () {
  'use strict';

  // Readiness flags — polled by Playwright waitForFunction()
  window.__mockState = {
    configDone: false,
    projectsDone: false,
    packagesDone: false,
    outdatedDone: false,
    inconsistentDone: false,
    vulnerableDone: false,
  };

  // ── Mock project data ──────────────────────────────────────────────────────
  // These represent .csproj files and their installed package references.
  // Newtonsoft.Json is intentionally installed at different versions across
  // projects so the Consolidate view has something to show.

  var PROJECTS = [
    {
      Name: 'MyApp.csproj',
      Path: '/workspace/MyApp/MyApp.csproj',
      CpmEnabled: false,
      Packages: [
        { Id: 'Newtonsoft.Json', Version: '12.0.3', IsPinned: false, VersionSource: 'project' },
        { Id: 'Serilog', Version: '2.11.0', IsPinned: false, VersionSource: 'project' },
        { Id: 'AutoMapper', Version: '11.0.1', IsPinned: false, VersionSource: 'project' },
      ],
    },
    {
      Name: 'MyApp.Tests.csproj',
      Path: '/workspace/MyApp/MyApp.Tests.csproj',
      CpmEnabled: false,
      Packages: [
        { Id: 'Newtonsoft.Json', Version: '13.0.1', IsPinned: false, VersionSource: 'project' },
        { Id: 'Microsoft.NET.Test.Sdk', Version: '17.0.0', IsPinned: false, VersionSource: 'project' },
      ],
    },
    {
      Name: 'MyApp.Core.csproj',
      Path: '/workspace/MyApp/MyApp.Core.csproj',
      CpmEnabled: false,
      Packages: [
        { Id: 'AutoMapper', Version: '11.0.1', IsPinned: false, VersionSource: 'project' },
        { Id: 'MediatR', Version: '10.0.0', IsPinned: false, VersionSource: 'project' },
        { Id: 'Microsoft.Extensions.Logging', Version: '7.0.0', IsPinned: false, VersionSource: 'project' },
      ],
    },
  ];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Collect all unique installed packages across projects, grouped by ID.
   * For packages installed at different versions, uses the minimum (oldest).
   * Each entry includes the list of projects it's installed in.
   */
  function getInstalledPackages() {
    var byId = {};
    PROJECTS.forEach(function (project) {
      project.Packages.forEach(function (pkg) {
        if (!byId[pkg.Id]) {
          byId[pkg.Id] = { id: pkg.Id, version: pkg.Version, projects: [] };
        } else {
          // Keep the lowest installed version for the outdated check
          if (pkg.Version < byId[pkg.Id].version) {
            byId[pkg.Id].version = pkg.Version;
          }
        }
        byId[pkg.Id].projects.push({ Name: project.Name, Path: project.Path, Version: pkg.Version });
      });
    });
    return Object.values(byId);
  }

  /**
   * Compute version inconsistencies directly from mock project data.
   * Returns the same shape as InconsistentPackage[].
   */
  function computeInconsistencies() {
    var byId = {};
    PROJECTS.forEach(function (project) {
      project.Packages.forEach(function (pkg) {
        if (!byId[pkg.Id]) byId[pkg.Id] = {};
        if (!byId[pkg.Id][pkg.Version]) byId[pkg.Id][pkg.Version] = [];
        byId[pkg.Id][pkg.Version].push({ Name: project.Name, Path: project.Path });
      });
    });

    var result = [];
    Object.keys(byId).forEach(function (id) {
      var versionMap = byId[id];
      var versions = Object.keys(versionMap);
      if (versions.length > 1) {
        var sorted = versions.slice().sort().reverse(); // rough desc sort
        result.push({
          Id: id,
          Versions: versions.map(function (v) { return { Version: v, Projects: versionMap[v] }; }),
          LatestInstalledVersion: sorted[0],
          CpmManaged: false,
        });
      }
    });
    return result;
  }

  // ── NuGet proxy call ───────────────────────────────────────────────────────

  var NUGET_PROXY_METHODS = [
    'getPackagesAsync',
    'getPackageAsync',
    'getPackageDetailsAsync',
    'getOutdatedPackagesAsync',
    'getVulnerablePackagesAsync',
  ];

  function callNugetProxy(msg) {
    var params = Object.assign({}, msg.params);

    // Inject installed packages for methods that need to compare against NuGet
    if (msg.method === 'getOutdatedPackagesAsync' || msg.method === 'getVulnerablePackagesAsync') {
      params._installedPackages = getInstalledPackages();
    }

    fetch('/nuget-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: msg.method, params: params }),
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        // Update readiness flags for the Playwright harness
        if (msg.method === 'getPackagesAsync') window.__mockState.packagesDone = true;
        if (msg.method === 'getOutdatedPackagesAsync') window.__mockState.outdatedDone = true;
        if (msg.method === 'getVulnerablePackagesAsync') window.__mockState.vulnerableDone = true;

        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'rpc-response', id: msg.id, result: result },
        }));
      })
      .catch(function (err) {
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'rpc-response', id: msg.id, result: { ok: false, error: err.message } },
        }));
      });
  }

  // ── Local mock handlers ────────────────────────────────────────────────────

  function getMockResponse(method, params) {
    switch (method) {
      case 'getConfigurationAsync':
        window.__mockState.configDone = true;
        return {
          ok: true,
          value: {
            Configuration: {
              SkipRestore: false,
              EnablePackageVersionInlineInfo: false,
              Prerelease: false,
              Sources: [{ Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' }],
              StatusBarLoadingIndicator: false,
            },
          },
        };

      case 'getProjectsAsync':
        window.__mockState.projectsDone = true;
        return { ok: true, value: { Projects: PROJECTS } };

      case 'getInconsistentPackagesAsync':
        window.__mockState.inconsistentDone = true;
        return { ok: true, value: { Packages: computeInconsistencies() } };

      case 'updateProjectAsync':
        return delay(1500).then(function () {
          var project = PROJECTS.find(function (p) { return p.Path === params.ProjectPath; });
          if (!project) return { ok: false, error: 'Project not found' };
          if (params.Type === 'INSTALL') {
            project.Packages.push({ Id: params.PackageId, Version: params.Version, IsPinned: false, VersionSource: 'project' });
          } else if (params.Type === 'UPDATE') {
            var pkg = project.Packages.find(function (p) { return p.Id === params.PackageId; });
            if (pkg) pkg.Version = params.Version;
          } else if (params.Type === 'UNINSTALL') {
            project.Packages = project.Packages.filter(function (p) { return p.Id !== params.PackageId; });
          }
          return { ok: true, value: { Project: project, IsCpmEnabled: false } };
        });

      case 'batchUpdatePackagesAsync':
        return delay(2000).then(function () {
          var updatedIds = [];
          (params.Updates || []).forEach(function (update) {
            updatedIds.push(update.PackageId);
            (update.ProjectPaths || []).forEach(function (path) {
              var project = PROJECTS.find(function (p) { return p.Path === path; });
              if (project) {
                var pkg = project.Packages.find(function (p) { return p.Id === update.PackageId; });
                if (pkg) pkg.Version = update.Version;
              }
            });
          });
          return {
            ok: true,
            value: { Results: updatedIds.map(function (id) { return { PackageId: id, Success: true }; }) },
          };
        });

      case 'consolidatePackagesAsync':
        return delay(1500).then(function () {
          (params.ProjectPaths || []).forEach(function (path) {
            var project = PROJECTS.find(function (p) { return p.Path === path; });
            if (project) {
              var pkg = project.Packages.find(function (p) { return p.Id === params.PackageId; });
              if (pkg) pkg.Version = params.TargetVersion;
            }
          });
          return { ok: true, value: undefined };
        });

      case 'restoreProjectsAsync':
        return delay(800).then(function () { return { ok: true, value: undefined }; });

      case 'updateConfigurationAsync':
        return { ok: true, value: undefined };

      case 'updateStatusBarAsync':
      case 'openUrlAsync':
        return { ok: true, value: undefined };

      case 'showConfirmationAsync':
        return { ok: true, value: { Confirmed: true } };

      case 'getOperationProgressAsync':
        return { ok: true, value: { Stage: 'Installing...', Percent: 50, Active: false } };

      default:
        console.warn('[mock-api] Unhandled RPC method:', method);
        return { ok: false, error: 'Unhandled method: ' + method };
    }
  }

  // ── acquireVsCodeApi stub ──────────────────────────────────────────────────

  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (!msg || msg.type !== 'rpc-request') return;

        // Route NuGet data methods to the live proxy
        if (NUGET_PROXY_METHODS.includes(msg.method)) {
          callNugetProxy(msg);
          return;
        }

        // Handle everything else locally
        Promise.resolve(getMockResponse(msg.method, msg.params)).then(function (result) {
          window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'rpc-response', id: msg.id, result: result },
          }));
        });
      },
      getState: function () { return {}; },
      setState: function () {},
    };
  };
})();
