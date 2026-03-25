import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  HostAPI,
  GetProjectsRequest,
  GetProjectsResponse,
  GetPackagesRequest,
  GetPackagesResponse,
  GetPackageRequest,
  GetPackageResponse,
  GetPackageDetailsRequest,
  GetPackageDetailsResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  GetConfigurationResponse,
  UpdateConfigurationRequest,
  OpenUrlRequest,
  UpdateStatusBarRequest,
  GetOutdatedPackagesRequest,
  GetOutdatedPackagesResponse,
  BatchUpdateRequest,
  BatchUpdateResponse,
  RestoreProjectsRequest,
  GetInconsistentPackagesRequest,
  GetInconsistentPackagesResponse,
  ConsolidateRequest,
  GetVulnerablePackagesRequest,
  GetVulnerablePackagesResponse,
  ShowConfirmationRequest,
  ShowConfirmationResponse,
  GetOperationProgressRequest,
  GetOperationProgressResponse,
} from "@/common/rpc/types";
import type { Result } from "@/common/rpc/result";
import { ok, fail } from "@/common/rpc/result";
import ProjectParser from "./utilities/project-parser";
import CpmResolver, { type CpmPackageMap } from "./utilities/cpm-resolver";
import nugetApiFactory from "./nuget/api-factory";
import NuGetConfigResolver from "./utilities/nuget-config-resolver";
import TaskExecutor, { DotnetError } from "./utilities/task-executor";
import StatusBarUtils from "./utilities/status-bar-utils";
import { Logger } from "../common/logger";
import { AxiosError } from "axios";

/**
 * Parses a .sln or .slnx file and returns the absolute paths of all project files it references.
 * Returns null if the file cannot be read or parsed.
 */
async function parseSolutionProjectPathsAsync(slnPath: string): Promise<string[] | null> {
  try {
    const content = await fs.readFile(slnPath, "utf-8");
    const slnDir = path.dirname(slnPath);
    const projectPaths: string[] = [];
    const ext = path.extname(slnPath).toLowerCase();

    if (ext === ".slnx") {
      // .slnx is XML: <Project Path="relative/path/to/Project.csproj" />
      const re = /<Project\s[^>]*\bPath="([^"]+\.(?:csproj|fsproj|vbproj))"/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const rel = m[1]!.replace(/\\/g, path.sep);
        projectPaths.push(path.resolve(slnDir, rel));
      }
    } else {
      // .sln text format: Project("...") = "Name", "relative\path.csproj", "{GUID}"
      const re = /^Project\([^)]+\)\s*=\s*"[^"]+",\s*"([^"]+\.(?:csproj|fsproj|vbproj))"/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const rel = m[1]!.replace(/\\/g, path.sep);
        projectPaths.push(path.resolve(slnDir, rel));
      }
    }

    return projectPaths;
  } catch {
    return null;
  }
}

/** Merges all CPM groups into a single flat map for ProjectParser (which expects a flat map). */
function buildFlatCpmMap(cpmMap: CpmPackageMap): Map<string, string> {
  const flat = new Map(cpmMap.unconditional);
  for (const entry of cpmMap.conditional) {
    for (const [id, version] of entry.versions) {
      if (!flat.has(id)) flat.set(id, version);
    }
  }
  return flat;
}

function extractResponseDetail(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    // GitLab: { error: "invalid_token", error_description: "Token is expired..." }
    if (obj.error_description) return String(obj.error_description);
    if (obj.error && typeof obj.error === "string") return String(obj.error);
    if (obj.message) return String(obj.message);
  }
  return "";
}

function formatApiError(err: unknown): string {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const url = err.config?.url ?? "unknown URL";
    const detail = extractResponseDetail(err.response?.data);
    const suffix = detail ? ` (${detail})` : "";
    if (status === 401) {
      return `Authentication failed (401) for ${url}.${suffix || " Check your credentials or access token."}`;
    }
    if (status === 403) {
      return `Access denied (403) for ${url}.${suffix || " Your token may lack the required permissions."}`;
    }
    if (status === 404) {
      return `Source not found (404): ${url}${suffix}`;
    }
    if (status) {
      return `HTTP ${status} from ${url}: ${err.message}${suffix}`;
    }
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
      return `Cannot connect to ${url} (${err.code}). Check your network or source URL.`;
    }
    return `Network error for ${url}: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function createHostAPI(): HostAPI {
  return {
    async getProjectsAsync(request: GetProjectsRequest, signal?: AbortSignal): Promise<Result<GetProjectsResponse>> {
      Logger.info("getProjects: Handling request");

      // Discover solution files (.sln / .slnx) in workspace roots (non-recursive).
      // If any exist, restrict project discovery to only the projects they reference.
      const slnFiles = await vscode.workspace.findFiles("*.{sln,slnx}", "**/node_modules/**");
      let solutionProjectPaths: Set<string> | null = null;

      if (slnFiles.length > 0) {
        const allPaths = (
          await Promise.all(slnFiles.map((f) => parseSolutionProjectPathsAsync(f.fsPath)))
        ).flat().filter((p): p is string => p !== null);
        if (allPaths.length > 0) {
          solutionProjectPaths = new Set(allPaths.map((p) => path.normalize(p)));
          Logger.info(`getProjects: Found ${slnFiles.length} solution file(s), ${solutionProjectPaths.size} project(s) referenced`);
        }
      }

      let projectFiles = await vscode.workspace.findFiles(
        "**/*.{csproj,fsproj,vbproj}",
        "**/node_modules/**"
      );

      if (solutionProjectPaths !== null) {
        projectFiles = projectFiles.filter((f) => solutionProjectPaths!.has(path.normalize(f.fsPath)));
      }

      Logger.info(`getProjects: Found ${projectFiles.length} project files`);

      const parseResults = await Promise.allSettled(
        projectFiles.map(async (file) => {
          if (signal?.aborted) throw new Error("cancelled");
          const cpmMap = await CpmResolver.GetFrameworkPackageMapAsync(file.fsPath);
          const cpmVersions = cpmMap ? buildFlatCpmMapAsync(cpmMap) : null;
          const project = await ProjectParser.ParseAsync(file.fsPath, cpmVersions);
          project.CpmEnabled = cpmMap !== null;
          if (cpmMap) {
            for (const pkg of project.Packages) {
              if (!cpmMap.unconditional.has(pkg.Id)) {
                const entry = cpmMap.conditional.find((e) => e.versions.has(pkg.Id));
                if (entry) pkg.CpmFramework = entry.framework;
              }
            }
          }
          return project;
        })
      );
      if (signal?.aborted) return fail("cancelled");
      const projects: Project[] = [];
      parseResults.forEach((r, i) => {
        if (r.status === "fulfilled") {
          projects.push(r.value);
        } else {
          Logger.error(`getProjects: Failed to parse project ${projectFiles[i]?.fsPath ?? "?"}`, r.reason);
        }
      });

      const sorted = projects.sort((a, b) =>
        a.Name?.toLowerCase().localeCompare(b.Name?.toLowerCase())
      );

      return ok({ Projects: sorted });
    },

    async getPackagesAsync(request: GetPackagesRequest, signal?: AbortSignal): Promise<Result<GetPackagesResponse>> {
      const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
      StatusBarUtils.show(0, "Loading packages...");

      try {
        if (request.ForceReload) {
          nugetApiFactory.ClearCache();
        }

        if (request.Url === "") {
          const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

          if (!request.Filter) {
            if (sources.length > 0) {
              request.Url = sources[0]?.Url ?? "";
            } else {
              return ok({ Packages: [] });
            }
          } else {
            let completed = 0;
            const promises = sources.map(async (source) => {
              try {
                const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
                return await api.GetPackagesAsync(
                  request.Filter,
                  request.Prerelease,
                  request.Skip,
                  request.Take,
                  signal
                );
              } catch (error) {
                Logger.error(`getPackages: Failed to fetch from ${source.Url}`, error);
                return { data: [] };
              } finally {
                completed++;
                StatusBarUtils.show((completed / sources.length) * 100, "Loading packages...");
              }
            });

            const results = await Promise.all(promises);
            const allPackages: Package[] = [];
            const seenIds = new Set<string>();

            for (const result of results) {
              for (const pkg of result.data) {
                if (!seenIds.has(pkg.Id)) {
                  seenIds.add(pkg.Id);
                  allPackages.push(pkg);
                }
              }
            }

            return ok({ Packages: allPackages });
          }
        }

        Logger.info(`getPackages: Fetching from ${request.Url} with filter '${request.Filter}'`);
        const api = await nugetApiFactory.GetSourceApiAsync(request.Url);
        const packages = await api.GetPackagesAsync(
          request.Filter,
          request.Prerelease,
          request.Skip,
          request.Take,
          signal
        );
        Logger.info(`getPackages: Successfully fetched ${packages.data.length} packages`);
        return ok({ Packages: packages.data });
      } catch (err: unknown) {
        Logger.error(`getPackages: Failed`, err);
        const detail = formatApiError(err);
        return fail(detail);
      } finally {
        StatusBarUtils.hide();
      }
    },

    async getPackageAsync(request: GetPackageRequest, signal?: AbortSignal): Promise<Result<GetPackageResponse>> {
      if (request.Url === "") {
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

        for (const source of sources) {
          try {
            const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
            if (request.ForceReload) {
              api.ClearPackageCache(request.Id);
            }
            const packageResult = await api.GetPackageAsync(request.Id, request.Prerelease, signal);

            if (!packageResult.isError && packageResult.data) {
              Logger.info(`getPackage: Found ${request.Id} in ${source.Url}`);
              return ok({ Package: packageResult.data, SourceUrl: source.Url });
            }
          } catch {
            Logger.warn(`getPackage: ${request.Id} not in ${source.Url}, trying next`);
          }
        }

        return fail("Failed to fetch package from any source");
      }

      try {
        const api = await nugetApiFactory.GetSourceApiAsync(request.Url);
        if (request.ForceReload) {
          api.ClearPackageCache(request.Id);
        }
        const packageResult = await api.GetPackageAsync(request.Id, request.Prerelease, signal);

        if (packageResult.isError || !packageResult.data) {
          return fail("Failed to fetch package");
        }

        Logger.info(`getPackage: Successfully fetched ${request.Id}`);
        return ok({ Package: packageResult.data, SourceUrl: request.Url });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`getPackage: Exception for ${request.Id}`, err);
        return fail(`Failed to fetch package: ${message}`);
      }
    },

    async getPackageDetailsAsync(request: GetPackageDetailsRequest, signal?: AbortSignal): Promise<Result<GetPackageDetailsResponse>> {
      if (!request.Url) return fail("SourceUrl is empty");
      if (!request.PackageVersionUrl) return fail("PackageVersionUrl is empty");

      try {
        const api = await nugetApiFactory.GetSourceApiAsync(request.Url);
        const details = await api.GetPackageDetailsAsync(request.PackageVersionUrl, signal);
        return ok({ Package: details.data });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`getPackageDetails: Failed for ${request.PackageVersionUrl}`, err);
        return fail(`Failed to fetch package details: ${message}`);
      }
    },

    async updateProjectAsync(request: UpdateProjectRequest): Promise<Result<UpdateProjectResponse>> {
      Logger.info(`updateProject: ${request.Type} ${request.PackageId} in ${request.ProjectPath}`);

      const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const normalizedProject = request.ProjectPath.replace(/\//g, "\\");
      const inWorkspace = workspacePaths.some((root) => normalizedProject.startsWith(root));
      if (!inWorkspace) {
        return fail(`Project path is outside the workspace: ${request.ProjectPath}`);
      }

      if (request.SourceUrl) {
        try { new URL(request.SourceUrl); } catch {
          return fail(`Invalid source URL: ${request.SourceUrl}`);
        }
      }

      const skipRestoreConfig = vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager").get<string>("skipRestore") ?? "";
      const cpmVersionsBefore = await CpmResolver.GetPackageVersionsAsync(request.ProjectPath);
      const isCpmEnabled = cpmVersionsBefore !== null;
      const skipRestore = !!skipRestoreConfig && !isCpmEnabled;

      try {
        if (request.Type === "UNINSTALL") {
          await executeRemovePackage(request.PackageId, request.ProjectPath, request.OperationId);
        } else if (isCpmEnabled && cpmVersionsBefore!.has(request.PackageId)) {
          if (!request.Version || !request.Version.trim()) {
            return fail("An explicit version is required when updating a Centrally Managed (CPM) package.");
          }
          await CpmResolver.UpdatePackageVersionAsync(request.ProjectPath, request.PackageId, request.Version);
          if (!skipRestore) {
            await TaskExecutor.ExecuteCommandAsync("dotnet", ["restore", request.ProjectPath.replace(/\\/g, "/")], request.OperationId ?? `restore-${request.PackageId}`);
          }
        } else {
          await executeAddPackage(
            request.PackageId,
            request.ProjectPath,
            request.Version,
            skipRestore,
            request.SourceUrl,
            request.OperationId,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`Failed to ${request.Type.toLowerCase()} package: ${message}`);
      } finally {
        StatusBarUtils.hide();
      }

      nugetApiFactory.ClearCache();

      const cpmVersions = await CpmResolver.GetPackageVersionsAsync(request.ProjectPath);
      const updatedProject = await ProjectParser.ParseAsync(request.ProjectPath, cpmVersions);

      return ok({ Project: updatedProject, IsCpmEnabled: isCpmEnabled });
    },

    async getConfigurationAsync(): Promise<Result<GetConfigurationResponse>> {
      Logger.info("getConfiguration: Retrieving configuration");
      const config = vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager");

      const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
      const sourcesWithCreds = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

      const sources: Source[] = sourcesWithCreds.map((s) => ({
        Name: s.Name,
        Url: s.Url,
      }));

      const vscodeSourcesRaw = config.get<string[]>("sources") ?? [];
      for (const rawSourceConfig of vscodeSourcesRaw) {
        try {
          const parsed = JSON.parse(rawSourceConfig) as {
            name?: string;
            passwordScriptPath?: string;
          };
          if (parsed.name && parsed.passwordScriptPath) {
            const source = sources.find((s) => s.Name === parsed.name);
            if (source) {
              source.PasswordScriptPath = parsed.passwordScriptPath;
            }
          }
        } catch (e) {
          Logger.warn(`getConfiguration: Failed to parse source config: ${rawSourceConfig}`, e);
        }
      }

      return ok({
        Configuration: {
          SkipRestore: config.get("skipRestore") ?? false,
          EnablePackageVersionInlineInfo: config.get("enablePackageVersionInlineInfo") ?? false,
          Prerelease: config.get("prerelease") ?? false,
          Sources: sources,
          StatusBarLoadingIndicator: config.get("statusBarLoadingIndicator") ?? false,
        },
      });
    },

    async updateConfigurationAsync(request: UpdateConfigurationRequest): Promise<Result<void>> {
      Logger.info("updateConfiguration: Updating configuration");
      const config = vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager");

      const sources = request.Configuration.Sources.map((x) =>
        JSON.stringify({
          name: x.Name,
          url: x.Url,
          ...(x.PasswordScriptPath && { passwordScriptPath: x.PasswordScriptPath }),
        })
      );

      if (config.get("skipRestore") !== request.Configuration.SkipRestore) {
        await config.update("skipRestore", request.Configuration.SkipRestore, vscode.ConfigurationTarget.Global);
      }
      if (config.get("enablePackageVersionInlineInfo") !== request.Configuration.EnablePackageVersionInlineInfo) {
        await config.update("enablePackageVersionInlineInfo", request.Configuration.EnablePackageVersionInlineInfo, vscode.ConfigurationTarget.Global);
      }
      if (config.get("prerelease") !== request.Configuration.Prerelease) {
        await config.update("prerelease", request.Configuration.Prerelease, vscode.ConfigurationTarget.Global);
      }
      const currentSources = config.get<string[]>("sources") ?? [];
      if (JSON.stringify(currentSources) !== JSON.stringify(sources)) {
        await config.update("sources", sources, vscode.ConfigurationTarget.Global);
      }

      Logger.info("updateConfiguration: Configuration updated successfully");
      return ok(undefined as void);
    },

    async openUrlAsync(request: OpenUrlRequest): Promise<Result<void>> {
      Logger.info(`openUrl: Opening ${request.Url}`);
      vscode.env.openExternal(vscode.Uri.parse(request.Url));
      return ok(undefined as void);
    },

    async updateStatusBarAsync(request: UpdateStatusBarRequest): Promise<Result<void>> {
      if (request.Percentage === null) {
        StatusBarUtils.hide();
      } else {
        StatusBarUtils.show(request.Percentage, request.Message);
      }
      return ok(undefined as void);
    },

    async getOutdatedPackagesAsync(request: GetOutdatedPackagesRequest, signal?: AbortSignal): Promise<Result<GetOutdatedPackagesResponse>> {
      Logger.info("getOutdatedPackages: Checking for outdated packages");
      StatusBarUtils.show(0, "Checking for updates...");

      if (request.ForceReload) {
        nugetApiFactory.ClearCache();
      }

      try {
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        let sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

        if (request.SourceUrl) {
          sources = sources.filter((s) => s.Url === request.SourceUrl);
        }

        if (sources.length === 0) {
          return ok({ Packages: [] });
        }

        let projectFiles = await vscode.workspace.findFiles(
          "**/*.{csproj,fsproj,vbproj}",
          "**/node_modules/**"
        );

        if (request.ProjectPaths && request.ProjectPaths.length > 0) {
          projectFiles = projectFiles.filter((f) => request.ProjectPaths!.includes(f.fsPath));
        }

        // Cache CpmPackageMap per project path to avoid re-reading shared Directory.Packages.props
        const cpmMapCache = new Map<string, CpmPackageMap | null>();

        const parseResults = await Promise.allSettled(
          projectFiles.map(async (file) => {
            const cpmVersions = await CpmResolver.GetPackageVersionsAsync(file.fsPath);
            const project = await ProjectParser.ParseAsync(file.fsPath, cpmVersions);
            project.CpmEnabled = cpmVersions !== null;

            if (project.CpmEnabled && !cpmMapCache.has(file.fsPath)) {
              cpmMapCache.set(file.fsPath, await CpmResolver.GetFrameworkPackageMapAsync(file.fsPath));
            }

            return project;
          })
        );
        const projects: Project[] = [];
        parseResults.forEach((r, i) => {
          if (r.status === "fulfilled") {
            projects.push(r.value);
          } else {
            Logger.error(`getOutdatedPackages: Failed to parse ${projectFiles[i]?.fsPath ?? "?"}`, r.reason);
          }
        });

        const installedMap = new Map<
          string,  // composite key: packageId + "\0" + condition
          { version: string; condition: string; framework: string; projects: Array<{ Name: string; Path: string; Version: string }> }
        >();

        for (const project of projects) {
          const cpmMap = cpmMapCache.get(project.Path) ?? null;

          for (const pkg of project.Packages) {
            if (!pkg.Version || pkg.IsPinned) continue;

            // Determine which condition (if any) this package belongs to
            let condition = "";
            let framework = "";
            if (cpmMap) {
              if (!cpmMap.unconditional.has(pkg.Id)) {
                const entry = cpmMap.conditional.find((e) => e.versions.has(pkg.Id));
                if (entry) {
                  condition = entry.condition;
                  framework = entry.framework;
                }
              }
            }

            const key = `${pkg.Id}\0${condition}`;
            const existing = installedMap.get(key);
            const projectInfo = { Name: project.Name, Path: project.Path, Version: pkg.Version };

            if (existing) {
              existing.projects.push(projectInfo);
              if (compareVersions(pkg.Version, existing.version) > 0) {
                existing.version = pkg.Version;
              }
            } else {
              installedMap.set(key, { version: pkg.Version, condition, framework, projects: [projectInfo] });
            }
          }
        }

        Logger.info(`getOutdatedPackages: ${installedMap.size} unique packages to check`);

        const outdated: OutdatedPackage[] = [];
        const installedKeys = Array.from(installedMap.keys());
        const batchSize = 5;

        for (let i = 0; i < installedKeys.length; i += batchSize) {
          if (signal?.aborted) break;
          const batch = installedKeys.slice(i, i + batchSize);
          const progress = Math.round(((i + batch.length) / installedKeys.length) * 100);
          StatusBarUtils.show(progress, `Checking updates (${i + batch.length}/${installedKeys.length})...`);

          const promises = batch.map(async (key) => {
            if (signal?.aborted) return;
            const installed = installedMap.get(key)!;
            // Extract the real package ID from the composite key (before the null-byte separator)
            const packageId = key.split("\0")[0]!;
            const latest = await getLatestVersion(packageId, request.Prerelease, sources, signal);

            if (signal?.aborted) return;
            if (latest && compareVersions(latest.version, installed.version) > 0) {
              const outdatedEntry: OutdatedPackage = {
                Id: packageId,
                InstalledVersion: installed.version,
                LatestVersion: latest.version,
                Projects: installed.projects,
                SourceUrl: latest.sourceUrl,
                SourceName: latest.sourceName,
              };
              if (installed.condition) outdatedEntry.CpmCondition = installed.condition;
              if (installed.framework) outdatedEntry.CpmFramework = installed.framework;
              outdated.push(outdatedEntry);
            }
          });

          await Promise.allSettled(promises);
        }

        outdated.sort((a, b) => a.Id.localeCompare(b.Id));
        Logger.info(`getOutdatedPackages: Found ${outdated.length} outdated packages`);
        return ok({ Packages: outdated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("getOutdatedPackages: Failed", err);
        return fail(`Failed to check for outdated packages: ${message}`);
      } finally {
        StatusBarUtils.hide();
      }
    },

    async batchUpdatePackagesAsync(request: BatchUpdateRequest): Promise<Result<BatchUpdateResponse>> {
      Logger.info(`batchUpdatePackages: Updating ${request.Updates.length} packages`);

      const results: Array<{ PackageId: string; Success: boolean; Error?: string }> = [];
      const configSkipRestore = !!vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager").get<string>("skipRestore");
      const skipRestore = request.SkipRestore === true || configSkipRestore;

      for (const [i, update] of request.Updates.entries()) {
        StatusBarUtils.ShowText(
          `Updating ${update.PackageId} to ${update.Version} (${i + 1}/${request.Updates.length})...`
        );

        try {
          for (const projectPath of update.ProjectPaths) {
            const cpmVersions = await CpmResolver.GetPackageVersionsAsync(projectPath);
            const isCpm = cpmVersions !== null;

            if (isCpm && cpmVersions!.has(update.PackageId)) {
              if (!update.Version) {
                throw new Error(`Version is required for CPM package update: ${update.PackageId}`);
              }
              await CpmResolver.UpdatePackageVersionAsync(projectPath, update.PackageId, update.Version, update.CpmCondition);
            } else {
              await executeAddPackage(update.PackageId, projectPath, update.Version, skipRestore);
            }
          }

          results.push({ PackageId: update.PackageId, Success: true });
          Logger.info(`batchUpdatePackages: Updated ${update.PackageId} to ${update.Version}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Logger.error(`batchUpdatePackages: Failed to update ${update.PackageId}`, err);
          results.push({ PackageId: update.PackageId, Success: false, Error: message });
        }
      }

      StatusBarUtils.hide();
      return ok({ Results: results });
    },

    async restoreProjectsAsync(request: RestoreProjectsRequest): Promise<Result<void>> {
      const configSkipRestore = !!vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager").get<string>("skipRestore");
      if (configSkipRestore) {
        Logger.info("restoreProjects: skipped (skipRestore setting is enabled)");
        return ok(undefined);
      }

      const uniquePaths = [...new Set(request.ProjectPaths)];
      Logger.info(`restoreProjects: Restoring ${uniquePaths.length} project(s)`);
      StatusBarUtils.ShowText("Restoring packages...");
      const failedPaths: string[] = [];
      try {
        for (const projectPath of uniquePaths) {
          try {
            await restoreWithConflictResolutionAsync(projectPath);
          } catch (err) {
            Logger.error(`restoreProjects: Failed to restore ${projectPath}`, err);
            failedPaths.push(projectPath);
          }
        }
      } finally {
        StatusBarUtils.hide();
      }
      if (failedPaths.length > 0) {
        return fail(`Restore failed for ${failedPaths.length} project(s). There may be version conflicts — try updating all related packages together.`);
      }
      return ok(undefined);
    },

    async getInconsistentPackagesAsync(request: GetInconsistentPackagesRequest, _signal?: AbortSignal): Promise<Result<GetInconsistentPackagesResponse>> {
      Logger.info("getInconsistentPackages: Checking for version inconsistencies");

      try {
        let projectFiles = await vscode.workspace.findFiles(
          "**/*.{csproj,fsproj,vbproj}",
          "**/node_modules/**"
        );

        if (request.ProjectPaths && request.ProjectPaths.length > 0) {
          projectFiles = projectFiles.filter((f) => request.ProjectPaths!.includes(f.fsPath));
        }

        const parseResults = await Promise.allSettled(
          projectFiles.map(async (file) => {
            const cpmMap = await CpmResolver.GetFrameworkPackageMapAsync(file.fsPath);
            const cpmVersions = cpmMap ? buildFlatCpmMapAsync(cpmMap) : null;
            const project = await ProjectParser.ParseAsync(file.fsPath, cpmVersions);
            project.CpmEnabled = cpmMap !== null;
            if (cpmMap) {
              for (const pkg of project.Packages) {
                if (!cpmMap.unconditional.has(pkg.Id)) {
                  const entry = cpmMap.conditional.find((e) => e.versions.has(pkg.Id));
                  if (entry) pkg.CpmFramework = entry.framework;
                }
              }
            }
            return project;
          })
        );
        const projects: Project[] = [];
        let anyCpmEnabled = false;
        parseResults.forEach((r, i) => {
          if (r.status === "fulfilled") {
            projects.push(r.value);
            if (r.value.CpmEnabled) anyCpmEnabled = true;
          } else {
            Logger.error(`getInconsistentPackages: Failed to parse ${projectFiles[i]?.fsPath ?? "?"}`, r.reason);
          }
        });

        // Key: "packageId\0cpmFramework" — framework-scoped packages are checked for
        // consistency only within the same framework group, not across frameworks.
        const packageMap = new Map<string, { framework: string; versions: Map<string, Array<{ Name: string; Path: string }>> }>();

        for (const project of projects) {
          for (const pkg of project.Packages) {
            if (!pkg.Version) continue;
            const framework = pkg.CpmFramework ?? "";
            const compositeKey = framework ? `${pkg.Id}\0${framework}` : pkg.Id;

            if (!packageMap.has(compositeKey)) {
              packageMap.set(compositeKey, { framework, versions: new Map() });
            }
            const entry = packageMap.get(compositeKey)!;
            if (!entry.versions.has(pkg.Version)) {
              entry.versions.set(pkg.Version, []);
            }
            entry.versions.get(pkg.Version)!.push({ Name: project.Name, Path: project.Path });
          }
        }

        const inconsistent: InconsistentPackage[] = [];

        for (const [compositeKey, { framework, versions: versionMap }] of packageMap) {
          if (versionMap.size <= 1) continue;
          const packageId = compositeKey.split("\0")[0]!;

          const versions = Array.from(versionMap.entries())
            .map(([version, projs]) => ({
              Version: version,
              Projects: projs,
              ...(framework ? { CpmFramework: framework } : {}),
            }))
            .sort((a, b) => compareVersions(b.Version, a.Version));

          inconsistent.push({
            Id: packageId,
            Versions: versions,
            LatestInstalledVersion: versions[0]?.Version ?? "",
            CpmManaged: anyCpmEnabled,
          });
        }

        inconsistent.sort((a, b) => a.Id.localeCompare(b.Id));
        Logger.info(`getInconsistentPackages: Found ${inconsistent.length} inconsistent packages`);
        return ok({ Packages: inconsistent });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("getInconsistentPackages: Failed", err);
        return fail(`Failed to check for inconsistent packages: ${message}`);
      }
    },

    async getVulnerablePackagesAsync(request: GetVulnerablePackagesRequest, signal?: AbortSignal): Promise<Result<GetVulnerablePackagesResponse>> {
      Logger.info("getVulnerablePackages: Scanning for vulnerable packages");
      StatusBarUtils.show(0, "Scanning for vulnerabilities...");

      try {
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

        if (request.ForceReload) {
          for (const source of sources) {
            const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
            api.ClearVulnerabilityCache();
          }
        }

        if (sources.length === 0) {
          return ok({ Packages: [] });
        }

        let projectFiles = await vscode.workspace.findFiles(
          "**/*.{csproj,fsproj,vbproj}",
          "**/node_modules/**"
        );

        if (request.ProjectPaths && request.ProjectPaths.length > 0) {
          projectFiles = projectFiles.filter((f) => request.ProjectPaths!.includes(f.fsPath));
        }

        const parseResults = await Promise.allSettled(
          projectFiles.map(async (file) => {
            const cpmVersions = await CpmResolver.GetPackageVersionsAsync(file.fsPath);
            return ProjectParser.ParseAsync(file.fsPath, cpmVersions);
          })
        );
        const projects: Project[] = [];
        parseResults.forEach((r, i) => {
          if (r.status === "fulfilled") {
            projects.push(r.value);
          } else {
            Logger.error(`getVulnerablePackages: Failed to parse ${projectFiles[i]?.fsPath ?? "?"}`, r.reason);
          }
        });

        // Collect all installed packages with their projects
        const installedMap = new Map<
          string,
          { version: string; projects: Array<{ Name: string; Path: string }> }
        >();

        for (const project of projects) {
          for (const pkg of project.Packages) {
            if (!pkg.Version) continue;
            const key = `${pkg.Id.toLowerCase()}::${pkg.Version}`;
            const existing = installedMap.get(key);
            if (existing) {
              existing.projects.push({ Name: project.Name, Path: project.Path });
            } else {
              installedMap.set(key, {
                version: pkg.Version,
                projects: [{ Name: project.Name, Path: project.Path }],
              });
            }
          }
        }

        StatusBarUtils.show(30, "Fetching vulnerability data...");

        // Fetch vulnerability data from all sources in parallel
        const allVulnerabilities = new Map<string, VulnerabilityEntry[]>();
        const vulnResults = await Promise.allSettled(
          sources.map(async (source) => {
            const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
            return { source, vulns: await api.GetVulnerabilitiesAsync(signal) };
          })
        );
        for (const result of vulnResults) {
          if (result.status === "fulfilled") {
            for (const [packageId, entries] of result.value.vulns) {
              const existing = allVulnerabilities.get(packageId) ?? [];
              existing.push(...entries);
              allVulnerabilities.set(packageId, existing);
            }
          } else {
            Logger.warn(`getVulnerablePackages: Failed to fetch vulns from a source`, result.reason);
          }
        }

        StatusBarUtils.show(60, "Matching vulnerabilities...");

        const vulnerable: VulnerablePackage[] = [];

        for (const [key, installed] of installedMap) {
          const packageId = key.split("::")[0] ?? "";
          const vulnEntries = allVulnerabilities.get(packageId);
          if (!vulnEntries) continue;

          // Find the highest-severity matching vulnerability
          let worstMatch: { severity: VulnerableSeverity; url: string; versions: string } | null = null;

          for (const entry of vulnEntries) {
            if (isVersionInRange(installed.version, entry.versions)) {
              if (!worstMatch || entry.severity > worstMatch.severity) {
                worstMatch = entry;
              }
            }
          }

          if (worstMatch) {
            vulnerable.push({
              Id: packageId,
              InstalledVersion: installed.version,
              Severity: worstMatch.severity,
              AdvisoryUrl: worstMatch.url,
              AffectedVersionRange: worstMatch.versions,
              Projects: installed.projects,
            });
          }
        }

        // Sort by severity (critical first), then by name
        vulnerable.sort((a, b) => b.Severity - a.Severity || a.Id.localeCompare(b.Id));

        Logger.info(`getVulnerablePackages: Found ${vulnerable.length} vulnerable packages`);
        return ok({ Packages: vulnerable });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("getVulnerablePackages: Failed", err);
        return fail(`Failed to scan for vulnerabilities: ${message}`);
      } finally {
        StatusBarUtils.hide();
      }
    },

    async showConfirmationAsync(request: ShowConfirmationRequest): Promise<Result<ShowConfirmationResponse>> {
      const opts: vscode.MessageOptions = { modal: true };
      if (request.Detail !== undefined) opts.detail = request.Detail;
      const answer = await vscode.window.showWarningMessage(
        request.Message,
        opts,
        "Yes"
      );
      return ok({ Confirmed: answer === "Yes" });
    },

    async getOperationProgressAsync(request: GetOperationProgressRequest): Promise<Result<GetOperationProgressResponse>> {
      const progress = TaskExecutor.GetProgress(request.OperationId);
      if (progress === null) {
        return ok({ Stage: "", Percent: 0, Active: false });
      }
      return ok({ Stage: progress.stage, Percent: progress.percent, Active: true });
    },

    async consolidatePackagesAsync(request: ConsolidateRequest): Promise<Result<void>> {
      Logger.info(
        `consolidatePackages: ${request.PackageId} to ${request.TargetVersion} across ${request.ProjectPaths.length} projects`
      );

      try {
        for (const [i, projectPath] of request.ProjectPaths.entries()) {
          StatusBarUtils.ShowText(
            `Consolidating ${request.PackageId} (${i + 1}/${request.ProjectPaths.length})...`
          );

          const cpmVersions = await CpmResolver.GetPackageVersionsAsync(projectPath);
          const isCpm = cpmVersions !== null;
          const skipRestore =
            !!vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager").get<string>("skipRestore") && !isCpm;

          if (isCpm && cpmVersions!.has(request.PackageId)) {
            await CpmResolver.UpdatePackageVersionAsync(projectPath, request.PackageId, request.TargetVersion);
            if (!skipRestore) {
              await TaskExecutor.ExecuteCommandAsync("dotnet", ["restore", projectPath.replace(/\\/g, "/")], `restore-${request.PackageId}`);
            }
          } else {
            await executeAddPackage(request.PackageId, projectPath, request.TargetVersion, skipRestore);
          }
        }

        StatusBarUtils.hide();
        Logger.info(`consolidatePackages: Done`);
        return ok(undefined as void);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`consolidatePackages: Failed`, err);
        StatusBarUtils.hide();
        return fail(`Failed to consolidate: ${message}`);
      }
    },
  };
}

// ============================================================
// Shared Helpers
// ============================================================

interface Nu1605Conflict {
  packageId: string;
  requiredVersion: string;
}

function parseNu1605Conflicts(output: string): Nu1605Conflict[] {
  const seen = new Set<string>();
  const conflicts: Nu1605Conflict[] = [];
  // Example line: "error NU1605: Detected package downgrade: Foo.Bar from 2.0.0 to 1.0.0-preview."
  const regex = /error NU1605: Detected package downgrade: (.+?) from (.+?) to /g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const packageId = match[1]!.trim();
    const requiredVersion = match[2]!.trim();
    if (!seen.has(packageId)) {
      seen.add(packageId);
      conflicts.push({ packageId, requiredVersion });
    }
  }
  return conflicts;
}

async function restoreWithConflictResolutionAsync(projectPath: string, attempt = 0): Promise<void> {
  const MAX_ATTEMPTS = 2;
  try {
    await TaskExecutor.ExecuteCommandAsync(
      "dotnet",
      ["restore", projectPath.replace(/\\/g, "/")],
      `restore-${projectPath}`
    );
  } catch (err) {
    if (!(err instanceof DotnetError) || attempt >= MAX_ATTEMPTS) {
      throw err;
    }

    const conflicts = parseNu1605Conflicts(err.output);
    if (conflicts.length === 0) {
      throw err;
    }

    Logger.info(`restoreWithConflictResolution: Detected ${conflicts.length} NU1605 conflict(s) in ${projectPath}, applying fixes`);

    const cpmVersions = await CpmResolver.GetPackageVersionsAsync(projectPath);
    let fixedAny = false;

    for (const { packageId, requiredVersion } of conflicts) {
      if (cpmVersions && cpmVersions.has(packageId)) {
        Logger.info(`restoreWithConflictResolution: Updating CPM ${packageId} to ${requiredVersion}`);
        await CpmResolver.UpdatePackageVersionAsync(projectPath, packageId, requiredVersion);
        fixedAny = true;
      } else {
        const project = await ProjectParser.ParseAsync(projectPath, null);
        const hasDirectRef = project.Packages.some((p) => p.Id === packageId);
        if (hasDirectRef) {
          Logger.info(`restoreWithConflictResolution: Updating direct reference ${packageId} to ${requiredVersion} in ${projectPath}`);
          await TaskExecutor.ExecuteCommandAsync(
            "dotnet",
            ["add", projectPath.replace(/\\/g, "/"), "package", packageId, "--version", requiredVersion, "--no-restore"],
            `fix-conflict-${packageId}`
          );
          fixedAny = true;
        }
      }
    }

    if (!fixedAny) {
      throw err;
    }

    await restoreWithConflictResolutionAsync(projectPath, attempt + 1);
  }
}

async function executeRemovePackage(packageId: string, projectPath: string, operationId?: string): Promise<void> {
  StatusBarUtils.ShowText(`Removing package ${packageId}...`);
  const args = ["remove", projectPath.replace(/\\/g, "/"), "package", packageId];
  await TaskExecutor.ExecuteCommandAsync("dotnet", args, operationId ?? `remove-${packageId}`);
}

async function executeAddPackage(
  packageId: string,
  projectPath: string,
  version?: string,
  skipRestore = false,
  sourceUrl?: string,
  operationId?: string
): Promise<void> {
  StatusBarUtils.ShowText(`Installing package ${packageId} ${version || "latest"}...`);
  const args = ["add", projectPath.replace(/\\/g, "/"), "package", packageId];

  if (version) {
    args.push("--version", version);
  }
  if (skipRestore) {
    args.push("--no-restore");
  }
  if (sourceUrl) {
    args.push("-s", sourceUrl);
  }

  await TaskExecutor.ExecuteCommandAsync("dotnet", args, operationId ?? `add-${packageId}`);
}

async function getLatestVersion(
  packageId: string,
  prerelease: boolean,
  sources: Array<{ Name: string; Url: string }>,
  signal?: AbortSignal
): Promise<{ version: string; sourceUrl: string; sourceName: string } | null> {
  let best: { version: string; sourceUrl: string; sourceName: string } | null = null;

  const promises = sources.map(async (source) => {
    try {
      const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
      const result = await api.GetPackagesAsync(packageId, prerelease, 0, 1, signal);
      const pkg = result.data.find((p) => p.Name.toLowerCase() === packageId.toLowerCase());
      if (pkg) {
        return { version: pkg.Version, sourceUrl: source.Url, sourceName: source.Name };
      }
    } catch {
      // Ignore feed errors
    }
    return null;
  });

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      if (!best || compareVersions(result.value.version, best.version) > 0) {
        best = result.value;
      }
    }
  }

  return best;
}

function compareVersions(a: string, b: string): number {
  const cleanA = a.replace(/[[\]()]/g, "");
  const cleanB = b.replace(/[[\]()]/g, "");

  const partsA = cleanA.split(/[.\-+]/).map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? p : n;
  });
  const partsB = cleanB.split(/[.\-+]/).map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? p : n;
  });

  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const pA = partsA[i] ?? 0;
    const pB = partsB[i] ?? 0;

    if (typeof pA === "number" && typeof pB === "number") {
      if (pA !== pB) return pA - pB;
    } else {
      const cmp = String(pA).localeCompare(String(pB));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/**
 * Checks if a version falls within a NuGet version range.
 * NuGet uses interval notation:
 *   [1.0.0, 2.0.0)  -> >= 1.0.0 AND < 2.0.0
 *   (1.0.0, 2.0.0]  -> > 1.0.0 AND <= 2.0.0
 *   [1.0.0, )        -> >= 1.0.0
 *   (, 2.0.0)        -> < 2.0.0
 */
function isVersionInRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed) return false;

  const lowerInclusive = trimmed.startsWith("[");
  const upperInclusive = trimmed.endsWith("]");

  const inner = trimmed.slice(1, -1);
  const commaIdx = inner.indexOf(",");

  if (commaIdx === -1) {
    // Exact version match: [1.0.0]
    if (lowerInclusive && upperInclusive) {
      return compareVersions(version, inner.trim()) === 0;
    }
    return false;
  }

  const lowerBound = inner.substring(0, commaIdx).trim();
  const upperBound = inner.substring(commaIdx + 1).trim();

  // Check lower bound
  if (lowerBound) {
    const cmp = compareVersions(version, lowerBound);
    if (lowerInclusive && cmp < 0) return false;
    if (!lowerInclusive && cmp <= 0) return false;
  }

  // Check upper bound
  if (upperBound) {
    const cmp = compareVersions(version, upperBound);
    if (upperInclusive && cmp > 0) return false;
    if (!upperInclusive && cmp >= 0) return false;
  }

  return true;
}
