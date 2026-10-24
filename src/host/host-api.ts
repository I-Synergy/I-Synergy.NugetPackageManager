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
  UpdateBadgeRequest,
  GetInconsistentPackagesRequest,
  GetInconsistentPackagesResponse,
  ConsolidateRequest,
  CleanupReport,
  CleanupUnusedRequest,
  CleanupUnusedResponse,
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
import CpmResolver, { type CpmPackageMap, type CpmVersionChange } from "./utilities/cpm-resolver";
import { getTfmMajorVersion } from "./utilities/cpm-condition";
import ProjectFrameworkResolver from "./utilities/project-framework-resolver";
import { findPathOutsideWorkspaceAsync } from "./utilities/workspace-path";
import { compareVersions, isVersionInRange } from "./utilities/version";
import { isValidNuGetVersion, isValidPackageId } from "./utilities/nuget-identifier";
import nugetApiFactory from "./nuget/api-factory";
import { SetUpdateBadge } from "./view-badge";
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

const DEFAULT_FRAMEWORK_ALIGNED_PATTERNS = [
  "Microsoft.Extensions.*",
  "Microsoft.AspNetCore.*",
  "Microsoft.EntityFrameworkCore.*",
  "Microsoft.Maui.*",
  "System.*",
];

function getCpmSettings(): {
  alignedPatterns: string[];
  extraTargetFrameworks: string[];
  excludeGlobs: string[];
} {
  const config = vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager");
  return {
    alignedPatterns: config.get<string[]>("frameworkAlignedPackages") ?? DEFAULT_FRAMEWORK_ALIGNED_PATTERNS,
    extraTargetFrameworks: config.get<string[]>("extraTargetFrameworks") ?? [],
    excludeGlobs: config.get<string[]>("excludeGlobs") ?? [],
  };
}

function matchesPackagePattern(pattern: string, packageId: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(packageId);
}

function isFrameworkAlignedPackage(packageId: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPackagePattern(pattern, packageId));
}

type CpmParseContext = {
  mapCache: Map<string, Promise<CpmPackageMap>>;
  tfmOverrides: string[];
};

function createCpmParseContext(): CpmParseContext {
  return {
    mapCache: new Map<string, Promise<CpmPackageMap>>(),
    tfmOverrides: getCpmSettings().extraTargetFrameworks,
  };
}

/**
 * Resolves the CPM map, target frameworks and per-package resolutions for one project.
 * Projects without a CPM file (or without conditional groups) skip MSBuild evaluation.
 */
async function parseProjectWithCpmAsync(
  projectPath: string,
  context: CpmParseContext
): Promise<{ project: Project; cpmMap: CpmPackageMap | null; tfms: string[] }> {
  const cpmFilePath = await CpmResolver.FindCpmFilePathAsync(projectPath);

  let cpmMap: CpmPackageMap | null = null;
  if (cpmFilePath) {
    if (!context.mapCache.has(cpmFilePath)) {
      context.mapCache.set(cpmFilePath, CpmResolver.ParseCpmFileAsync(cpmFilePath));
    }
    const promise = context.mapCache.get(cpmFilePath);
    if (promise) {
      cpmMap = await promise;
    }
  }

  const tfmInfo = cpmMap?.hasConditionalGroups
    ? await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath, context.tfmOverrides)
    : { Frameworks: [] as string[], Source: "xml" as const };

  const cpmVersions = cpmMap ? buildFlatCpmMap(cpmMap) : null;
  const project = await ProjectParser.ParseAsync(projectPath, cpmVersions);
  project.CpmEnabled = cpmMap !== null;
  project.TargetFrameworks = tfmInfo.Frameworks;
  project.TfmSource = tfmInfo.Source;

  if (cpmMap) {
    const packageIds = project.Packages.map((pkg) => pkg.Id);
    const resolutions = CpmResolver.ResolveVersions(cpmMap, packageIds, tfmInfo.Frameworks);

    for (const pkg of project.Packages) {
      const resolved = resolutions.get(pkg.Id);
      if (!resolved || resolved.length === 0) continue;

      pkg.CpmResolutions = resolved;

      const conditional = resolved.find((item) => item.Condition !== "");
      if (conditional) {
        pkg.CpmFramework = conditional.ConditionLabel;
      }

      const versions = [...new Set(resolved.map((item) => item.Version))];
      if (versions.length === 1) {
        pkg.Version = versions[0]!;
      }
    }
  }

  return { project, cpmMap, tfms: tfmInfo.Frameworks };
}

/** Excludes configured globs (for example bin and obj folders) from project discovery. */
function applyExcludeGlobs<T extends { fsPath: string }>(files: T[], excludeGlobs: string[]): T[] {
  if (excludeGlobs.length === 0) return files;
  const patterns = excludeGlobs.map(
    (glob) =>
      new RegExp(
        `^${glob
          .replace(/\\/g, "/")
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\0")
          .replace(/\*/g, "[^/]*")
          .replace(/\0/g, ".*")
          .replace(/\/$/, "")}$`,
        "i"
      )
  );
  return files.filter((file) => {
    const normalized = file.fsPath.replace(/\\/g, "/");
    return !patterns.some((pattern) => pattern.test(normalized));
  });
}

function sortPackages(packages: Package[], sort?: string): Package[] {
  if (!sort || sort === "relevance" || sort === "recent") return packages;
  const copy = [...packages];
  if (sort === "downloads") {
    return copy.sort((a, b) => b.TotalDownloads - a.TotalDownloads);
  }
  if (sort === "name-asc") {
    return copy.sort((a, b) => a.Id.localeCompare(b.Id));
  }
  return packages;
}

function getWorkspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/** Returns the first path outside the workspace, or null when every path is safe. */
async function findOutsideWorkspaceAsync(paths: string[]): Promise<string | null> {
  return findPathOutsideWorkspaceAsync(paths, getWorkspaceRoots());
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
      const settings = getCpmSettings();

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
      projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);

      if (solutionProjectPaths !== null) {
        projectFiles = projectFiles.filter((f) => solutionProjectPaths!.has(path.normalize(f.fsPath)));
      }

      Logger.info(`getProjects: Found ${projectFiles.length} project files`);

      const cpmContext = createCpmParseContext();
      const showTfmProgress = projectFiles.length > 20;
      if (showTfmProgress) {
        StatusBarUtils.ShowText(`Resolving target frameworks for ${projectFiles.length} projects...`);
      }
      let parseResults: PromiseSettledResult<Project>[];
      try {
        parseResults = await Promise.allSettled(
          projectFiles.map(async (file) => {
            if (signal?.aborted) throw new Error("cancelled");
            const parsed = await parseProjectWithCpmAsync(file.fsPath, cpmContext);
            return parsed.project;
          })
        );
      } finally {
        if (showTfmProgress) {
          StatusBarUtils.hide();
        }
      }
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

            return ok({ Packages: sortPackages(allPackages, request.Sort) });
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
        return ok({ Packages: sortPackages(packages.data, request.Sort) });
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

    async updateProjectAsync(request: UpdateProjectRequest, signal?: AbortSignal): Promise<Result<UpdateProjectResponse>> {
      Logger.info(`updateProject: ${request.Type} ${request.PackageId} in ${request.ProjectPath}`);

      const outsideWorkspace = await findOutsideWorkspaceAsync([request.ProjectPath]);
      if (outsideWorkspace) {
        return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
      }

      if (!isValidPackageId(request.PackageId)) {
        return fail(`Invalid NuGet package ID: ${request.PackageId}`);
      }
      if (request.Version && !isValidNuGetVersion(request.Version)) {
        return fail(`Invalid NuGet version: ${request.Version}`);
      }

      if (request.SourceUrl) {
        try {
          const protocol = new URL(request.SourceUrl).protocol;
          if (protocol !== "https:" && protocol !== "http:") {
            return fail(`Invalid source URL: ${request.SourceUrl}`);
          }
        } catch {
          return fail(`Invalid source URL: ${request.SourceUrl}`);
        }
      }

      if (signal?.aborted) {
        return fail("cancelled");
      }

      const skipRestoreConfig = vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager").get<string>("skipRestore") ?? "";
      const cpmMapBefore = await CpmResolver.GetFrameworkPackageMapAsync(request.ProjectPath);
      const isCpmEnabled = cpmMapBefore !== null;
      const isCpmPackage = cpmMapBefore !== null && CpmResolver.HasPackage(cpmMapBefore, request.PackageId);
      const skipRestore = !!skipRestoreConfig && !isCpmEnabled;

      try {
        if (request.Type === "UNINSTALL") {
          await executeRemovePackage(request.PackageId, request.ProjectPath, request.OperationId, signal);
          if (isCpmPackage) {
            await cleanupUnusedCpmPackageAsync(request.PackageId, signal);
          }
        } else if (isCpmEnabled && isCpmPackage) {
          if (!request.Version || !request.Version.trim()) {
            return fail("An explicit version is required when updating a Centrally Managed (CPM) package.");
          }

          const conditionalGroups = cpmMapBefore!.conditional.filter((entry) =>
            [...entry.versions.keys()].some(
              (id) => id.toLowerCase() === request.PackageId.toLowerCase()
            )
          );
          const unconditional = [...cpmMapBefore!.unconditional.keys()].some(
            (id) => id.toLowerCase() === request.PackageId.toLowerCase()
          );
          const onlyGroup = !unconditional && conditionalGroups.length === 1
            ? conditionalGroups[0]
            : undefined;

          let condition = request.CpmCondition;
          let scope: "group" | "unconditional";
          if (condition !== undefined) {
            scope = "group";
          } else if (unconditional) {
            scope = "unconditional";
          } else if (onlyGroup) {
            condition = onlyGroup.condition;
            scope = "group";
          } else {
            return fail(
              `Package ${request.PackageId} has multiple framework-scoped versions; update it from the Updates tab.`
            );
          }

          await CpmResolver.UpdatePackageVersionAsync(
            request.ProjectPath,
            request.PackageId,
            request.Version,
            condition,
            scope
          );
          if (!skipRestore) {
            await TaskExecutor.ExecuteCommandAsync("dotnet", ["restore", request.ProjectPath.replace(/\\/g, "/")], request.OperationId ?? `restore-${request.PackageId}`, signal);
          }
        } else {
          await executeAddPackage(
            request.PackageId,
            request.ProjectPath,
            request.Version,
            skipRestore,
            request.SourceUrl,
            request.OperationId,
            signal,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`Failed to ${request.Type.toLowerCase()} package: ${message}`);
      } finally {
        StatusBarUtils.hide();
      }

      nugetApiFactory.ClearCache();

      const parsed = await parseProjectWithCpmAsync(request.ProjectPath, createCpmParseContext());
      const updatedProject = parsed.project;

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
      let protocol = "";
      try {
        protocol = new URL(request.Url).protocol;
      } catch {
        return fail(`Invalid URL: ${request.Url}`);
      }
      if (protocol !== "https:" && protocol !== "http:") {
        return fail(`Refusing to open unsupported URL scheme: ${protocol}`);
      }
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

      if (request.ProjectPaths?.length) {
        const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
        if (outsideWorkspace) {
          StatusBarUtils.hide();
          return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
        }
      }

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

        const settings = getCpmSettings();
        let projectFiles = await vscode.workspace.findFiles(
          "**/*.{csproj,fsproj,vbproj}",
          "**/node_modules/**"
        );
        projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);

        if (request.ProjectPaths && request.ProjectPaths.length > 0) {
          projectFiles = projectFiles.filter((f) => request.ProjectPaths!.includes(f.fsPath));
        }

        // Shares CPM parses and TFM evaluation across all projects in this request.
        const cpmContext = createCpmParseContext();

        const parseResults = await Promise.allSettled(
          projectFiles.map(async (file) => parseProjectWithCpmAsync(file.fsPath, cpmContext))
        );
        const projects: Project[] = [];
        const projectCpmMaps = new Map<string, CpmPackageMap | null>();
        parseResults.forEach((r, i) => {
          if (r.status === "fulfilled") {
            projects.push(r.value.project);
            projectCpmMaps.set(r.value.project.Path, r.value.cpmMap);
          } else {
            Logger.error(`getOutdatedPackages: Failed to parse ${projectFiles[i]?.fsPath ?? "?"}`, r.reason);
          }
        });

        const installedMap = new Map<
          string,  // composite key: packageId + "\0" + condition + "\0" + tfm
          {
            version: string;
            condition: string;
            framework: string;
            conditionLabel: string;
            matched: boolean;
            projects: Array<{ Name: string; Path: string; Version: string }>;
          }
        >();

        for (const project of projects) {
          const cpmMap = projectCpmMaps.get(project.Path) ?? null;

          for (const pkg of project.Packages) {
            if (!pkg.Version || pkg.IsPinned) continue;

            const resolutions = cpmMap && pkg.CpmResolutions?.length
              ? pkg.CpmResolutions
              : [{
                  Tfm: "",
                  Version: pkg.Version,
                  Condition: "",
                  ConditionLabel: "",
                  Matched: true,
                }];

            for (const resolution of resolutions) {
              if (!resolution.Version) continue;

              const key = `${pkg.Id}\0${resolution.Condition}`;
              const existing = installedMap.get(key);
              const projectInfo = { Name: project.Name, Path: project.Path, Version: resolution.Version };

              if (existing) {
                existing.projects.push(projectInfo);
                existing.matched = existing.matched && resolution.Matched;
                if (compareVersions(resolution.Version, existing.version) < 0) {
                  existing.version = resolution.Version;
                }
              } else {
                installedMap.set(key, {
                  version: resolution.Version,
                  condition: resolution.Condition,
                  framework: resolution.Tfm,
                  conditionLabel: resolution.ConditionLabel,
                  matched: resolution.Matched,
                  projects: [projectInfo],
                });
              }
            }
          }
        }

        Logger.info(`getOutdatedPackages: ${installedMap.size} unique packages to check`);

        const outdated: OutdatedPackage[] = [];
        const installedKeys = Array.from(installedMap.keys());
        const batchSize = 5;
        const latestCache = new Map<string, Promise<Awaited<ReturnType<typeof getLatestVersion>>>>();

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
            const lookupKey = `${packageId}\0${request.Prerelease}`;
            if (!latestCache.has(lookupKey)) {
              latestCache.set(lookupKey, getLatestVersion(packageId, request.Prerelease, sources, signal));
            }
            const latest = await latestCache.get(lookupKey)!;

            if (signal?.aborted) return;
            if (!latest || compareVersions(latest.version, installed.version) <= 0) return;

            const tfmMajor = installed.framework ? getTfmMajorVersion(installed.framework) : null;
            const aligned = tfmMajor !== null && isFrameworkAlignedPackage(packageId, settings.alignedPatterns);
            const compatibleVersion = aligned && tfmMajor !== null
              ? (getLatestInMajor(latest.versions, tfmMajor) ?? installed.version)
              : latest.version;

            const primary = compareVersions(compatibleVersion, installed.version) > 0
              ? compatibleVersion
              : latest.version;

            const outdatedEntry: OutdatedPackage = {
              Id: packageId,
              InstalledVersion: installed.version,
              LatestVersion: primary,
              Projects: installed.projects,
              SourceUrl: latest.sourceUrl,
              SourceName: latest.sourceName,
            };
            if (installed.condition) outdatedEntry.CpmCondition = installed.condition;
            if (installed.framework) outdatedEntry.CpmFramework = installed.framework;
            if (installed.conditionLabel) outdatedEntry.CpmConditionLabel = installed.conditionLabel;
            if (!installed.matched) outdatedEntry.CpmMatched = false;
            if (compareVersions(latest.version, primary) > 0) {
              outdatedEntry.LatestOverallVersion = latest.version;
            }
            outdated.push(outdatedEntry);
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

    async batchUpdatePackagesAsync(request: BatchUpdateRequest, signal?: AbortSignal): Promise<Result<BatchUpdateResponse>> {
      Logger.info(`batchUpdatePackages: Updating ${request.Updates.length} packages`);

      const outsideWorkspace = await findOutsideWorkspaceAsync(
        request.Updates.flatMap((update) => update.ProjectPaths)
      );
      if (outsideWorkspace) {
        return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
      }

      const results: Array<{ PackageId: string; Success: boolean; Error?: string }> = [];
      const configSkipRestore = !!vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager").get<string>("skipRestore");
      const skipRestore = request.SkipRestore === true || configSkipRestore;
      const cpmMapCache = new Map<string, Promise<CpmPackageMap>>();
      const transactional = request.Transactional === true;
      const allProjectPaths = [...new Set(request.Updates.flatMap((update) => update.ProjectPaths))];
      let snapshots: Map<string, FileSnapshot> | undefined;

      if (transactional) {
        const affectedFiles = new Set<string>(allProjectPaths);
        for (const update of request.Updates) {
          for (const projectPath of update.ProjectPaths) {
            const cpmFilePath = await CpmResolver.FindCpmFilePathAsync(projectPath);
            if (cpmFilePath) affectedFiles.add(cpmFilePath);
          }
        }
        snapshots = await snapshotFilesAsync([...affectedFiles]);
      }

      let transactionFailed = false;
      for (const [i, update] of request.Updates.entries()) {
        if (signal?.aborted) break;
        StatusBarUtils.ShowText(
          `Updating ${update.PackageId} to ${update.Version} (${i + 1}/${request.Updates.length})...`
        );

        if (!isValidPackageId(update.PackageId)) {
          results.push({ PackageId: update.PackageId, Success: false, Error: `Invalid NuGet package ID: ${update.PackageId}` });
          continue;
        }
        if (update.Version && !isValidNuGetVersion(update.Version)) {
          results.push({ PackageId: update.PackageId, Success: false, Error: `Invalid NuGet version: ${update.Version}` });
          continue;
        }

        try {
          const cpmChanges = new Map<string, CpmVersionChange>();
          const nonCpmProjects: string[] = [];

          for (const projectPath of update.ProjectPaths) {
            const cpmFilePath = await CpmResolver.FindCpmFilePathAsync(projectPath);

            let cpmMap: CpmPackageMap | null = null;
            if (cpmFilePath) {
              if (!cpmMapCache.has(cpmFilePath)) {
                cpmMapCache.set(cpmFilePath, CpmResolver.ParseCpmFileAsync(cpmFilePath));
              }
              cpmMap = await cpmMapCache.get(cpmFilePath)!;
            }

            if (!cpmMap || !CpmResolver.HasPackage(cpmMap, update.PackageId)) {
              nonCpmProjects.push(projectPath);
              continue;
            }

            if (!update.Version) {
              throw new Error(`Version is required for CPM package update: ${update.PackageId}`);
            }

            let condition = update.CpmCondition;
            let scope = update.Scope;
            if (condition === undefined) {
              const unconditional = cpmMap.unconditional.has(update.PackageId)
                || [...cpmMap.unconditional.keys()].some(
                  (id) => id.toLowerCase() === update.PackageId.toLowerCase()
                );
              const conditionalGroups = cpmMap.conditional.filter((entry) =>
                [...entry.versions.keys()].some(
                  (id) => id.toLowerCase() === update.PackageId.toLowerCase()
                )
              );

              if (!unconditional && conditionalGroups.length === 1 && conditionalGroups[0]) {
                condition = conditionalGroups[0].condition;
                scope = scope ?? "group";
              } else if (unconditional) {
                scope = scope ?? "unconditional";
              } else {
                throw new Error(
                  `Package ${update.PackageId} has multiple framework-scoped versions; specify CpmCondition.`
                );
              }
            } else {
              scope = scope ?? "group";
            }

            const change: CpmVersionChange = {
              packageId: update.PackageId,
              version: update.Version,
              scope,
            };
            if (condition !== undefined) {
              change.condition = condition;
            }

            const key = `${cpmFilePath}\0${update.PackageId}\0${condition ?? ""}`;
            const existing = cpmChanges.get(key);
            if (existing && existing.version !== update.Version) {
              throw new Error(
                `Conflicting versions requested for ${update.PackageId} in ${cpmFilePath}: ${existing.version} vs ${update.Version}`
              );
            }
            cpmChanges.set(key, change);
          }

          const changesByFile = new Map<string, CpmVersionChange[]>();
          for (const [key, change] of cpmChanges) {
            const propsFilePath = key.split("\0")[0]!;
            const list = changesByFile.get(propsFilePath) ?? [];
            list.push(change);
            changesByFile.set(propsFilePath, list);
          }

          for (const [propsFilePath, changes] of changesByFile) {
            await CpmResolver.UpdateCpmVersionsAsync(propsFilePath, changes);
          }

          for (const projectPath of nonCpmProjects) {
            await executeAddPackage(update.PackageId, projectPath, update.Version, skipRestore, undefined, undefined, signal);
          }

          results.push({ PackageId: update.PackageId, Success: true });
          Logger.info(`batchUpdatePackages: Updated ${update.PackageId} to ${update.Version}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Logger.error(`batchUpdatePackages: Failed to update ${update.PackageId}`, err);
          results.push({ PackageId: update.PackageId, Success: false, Error: message });
          if (transactional) {
            transactionFailed = true;
            break;
          }
        }
      }

      if (transactional) {
        let restoreError: string | undefined;
        if (!transactionFailed && !skipRestore) {
          StatusBarUtils.ShowText("Restoring updated projects...");
          restoreError = await restoreProjectsInternalAsync(allProjectPaths, signal, true) ?? undefined;
        }

        if (transactionFailed || restoreError) {
          const rollbackError = await rollbackFilesAsync(snapshots);
          let rollbackRestoreError: string | undefined;
          if (!skipRestore && (transactionFailed || restoreError)) {
            rollbackRestoreError = await restoreProjectsInternalAsync(allProjectPaths, signal, false) ?? undefined;
          }
          StatusBarUtils.hide();
          Logger.error("batchUpdatePackages: Transaction rolled back", restoreError ?? "write failure");
          const response: BatchUpdateResponse = { Results: results, RolledBack: true };
          if (restoreError) response.RestoreError = restoreError;
          const rollbackMessage = rollbackError ?? rollbackRestoreError;
          if (rollbackMessage) response.RollbackError = rollbackMessage;
          return ok(response);
        }
      }

      StatusBarUtils.hide();
      return ok({ Results: results });
    },

    async updateBadgeAsync(request: UpdateBadgeRequest): Promise<Result<void>> {
      SetUpdateBadge(request.Count);
      return ok(undefined);
    },

    async getCleanupReportAsync(
      _request: CleanupUnusedRequest,
      signal?: AbortSignal
    ): Promise<Result<CleanupReport>> {
      try {
        return ok(await buildCleanupReportAsync(signal));
      } catch (err) {
        return fail(`Failed to build cleanup report: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async cleanupUnusedPackagesAsync(
      _request: CleanupUnusedRequest,
      signal?: AbortSignal
    ): Promise<Result<CleanupUnusedResponse>> {
      try {
        const report = await buildCleanupReportAsync(signal);
        const removed: string[] = [];
        const backups: string[] = [];
        const errors: string[] = [];
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");

        for (const propsFile of report.PropsFiles) {
          if (propsFile.Unused.length === 0) continue;
          const backupPath = `${propsFile.Path}.backup.${stamp}`;
          try {
            await fs.copyFile(propsFile.Path, backupPath);
            backups.push(backupPath);
          } catch (err) {
            errors.push(`Backup failed for ${propsFile.Path}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          for (const packageId of propsFile.Unused) {
            if (signal?.aborted) break;
            try {
              const didRemove = await CpmResolver.RemovePackageVersionAsync(propsFile.Path, packageId);
              if (didRemove) removed.push(packageId);
            } catch (err) {
              errors.push(`Failed to remove ${packageId} from ${propsFile.Path}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        return ok({ Report: report, Removed: [...new Set(removed)], Backups: backups, Errors: errors });
      } catch (err) {
        return fail(`Failed to clean unused packages: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async restoreProjectsAsync(request: RestoreProjectsRequest, signal?: AbortSignal): Promise<Result<void>> {
      const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
      if (outsideWorkspace) {
        return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
      }

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
          if (signal?.aborted) break;
          try {
            await restoreWithConflictResolutionAsync(projectPath, 0, signal);
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

      if (request.ProjectPaths?.length) {
        const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
        if (outsideWorkspace) {
          return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
        }
      }

      try {
        const settings = getCpmSettings();
        let projectFiles = await vscode.workspace.findFiles(
          "**/*.{csproj,fsproj,vbproj}",
          "**/node_modules/**"
        );
        projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);

        if (request.ProjectPaths && request.ProjectPaths.length > 0) {
          projectFiles = projectFiles.filter((f) => request.ProjectPaths!.includes(f.fsPath));
        }

        const cpmContext = createCpmParseContext();
        const parseResults = await Promise.allSettled(
          projectFiles.map(async (file) => parseProjectWithCpmAsync(file.fsPath, cpmContext))
        );
        const projects: Project[] = [];
        let anyCpmEnabled = false;
        parseResults.forEach((r, i) => {
          if (r.status === "fulfilled") {
            projects.push(r.value.project);
            if (r.value.project.CpmEnabled) anyCpmEnabled = true;
          } else {
            Logger.error(`getInconsistentPackages: Failed to parse ${projectFiles[i]?.fsPath ?? "?"}`, r.reason);
          }
        });

        // Key: "packageId\0condition\0tfm" — framework-scoped packages are checked for
        // consistency only within the same framework group, not across frameworks.
        // Key: "packageId\0condition\0tfm" — a package may legitimately have one
        // version per target framework; only versions inside the same framework
        // line are comparable. Never collapse net10.0 and net11.0 into one row.
        const packageMap = new Map<string, {
          packageId: string;
          framework: string;
          condition: string;
          conditionLabel: string;
          versions: Map<string, Array<{ Name: string; Path: string }>>;
        }>();

        for (const project of projects) {
          for (const pkg of project.Packages) {
            if (!pkg.Version) continue;

            const resolutions = pkg.CpmResolutions?.length
              ? pkg.CpmResolutions
              : [{ Tfm: "", Version: pkg.Version, Condition: "", ConditionLabel: "", Matched: true }];

            for (const resolution of resolutions) {
              if (!resolution.Version) continue;
              const compositeKey = `${pkg.Id}\0${resolution.Condition}\0${resolution.Tfm}`;

              if (!packageMap.has(compositeKey)) {
                packageMap.set(compositeKey, {
                  packageId: pkg.Id,
                  framework: resolution.Tfm,
                  condition: resolution.Condition,
                  conditionLabel: resolution.ConditionLabel,
                  versions: new Map(),
                });
              }
              const entry = packageMap.get(compositeKey)!;
              if (!entry.versions.has(resolution.Version)) {
                entry.versions.set(resolution.Version, []);
              }
              entry.versions.get(resolution.Version)!.push({ Name: project.Name, Path: project.Path });
            }
          }
        }

        const inconsistent: InconsistentPackage[] = [];

        for (const { packageId, framework, condition, conditionLabel, versions: versionMap } of packageMap.values()) {
          if (versionMap.size <= 1) continue;

          const versions = Array.from(versionMap.entries())
            .map(([version, projs]) => ({
              Version: version,
              Projects: projs,
              ...(framework ? { CpmFramework: framework } : {}),
              ...(condition ? { CpmCondition: condition } : {}),
              ...(conditionLabel ? { CpmConditionLabel: conditionLabel } : {}),
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

      if (request.ProjectPaths?.length) {
        const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
        if (outsideWorkspace) {
          StatusBarUtils.hide();
          return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
        }
      }

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

        const settings = getCpmSettings();
        let projectFiles = await vscode.workspace.findFiles(
          "**/*.{csproj,fsproj,vbproj}",
          "**/node_modules/**"
        );
        projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);

        if (request.ProjectPaths && request.ProjectPaths.length > 0) {
          projectFiles = projectFiles.filter((f) => request.ProjectPaths!.includes(f.fsPath));
        }

        const cpmContext = createCpmParseContext();
        const parseResults = await Promise.allSettled(
          projectFiles.map(async (file) => parseProjectWithCpmAsync(file.fsPath, cpmContext))
        );
        const projects: Project[] = [];
        parseResults.forEach((r, i) => {
          if (r.status === "fulfilled") {
            projects.push(r.value.project);
          } else {
            Logger.error(`getVulnerablePackages: Failed to parse ${projectFiles[i]?.fsPath ?? "?"}`, r.reason);
          }
        });

        // Collect all installed package versions with their projects. A package can
        // have a different version per TFM, so each resolved version is scanned.
        const installedMap = new Map<
          string,
          {
            id: string;
            version: string;
            projects: Array<{ Name: string; Path: string }>;
            frameworks: Set<string>;
            direct: boolean;
            dependencyOf: Set<string>;
          }
        >();

        for (const project of projects) {
          for (const pkg of project.Packages) {
            if (!pkg.Version) continue;

            const resolutions = pkg.CpmResolutions?.length
              ? pkg.CpmResolutions
              : [{ Tfm: "", Version: pkg.Version, Condition: "", ConditionLabel: "", Matched: true }];

            for (const resolution of resolutions) {
              if (!resolution.Version) continue;
              const key = `${pkg.Id.toLowerCase()}::${resolution.Version}`;
              const existing = installedMap.get(key);
              if (existing) {
                if (!existing.projects.some((p) => p.Path === project.Path)) {
                  existing.projects.push({ Name: project.Name, Path: project.Path });
                }
                if (resolution.Tfm) existing.frameworks.add(resolution.Tfm);
                existing.direct = true;
              } else {
                installedMap.set(key, {
                  id: pkg.Id,
                  version: resolution.Version,
                  projects: [{ Name: project.Name, Path: project.Path }],
                  frameworks: new Set(resolution.Tfm ? [resolution.Tfm] : []),
                  direct: true,
                  dependencyOf: new Set(),
                });
              }
            }
          }
        }

        // project.assets.json includes transitive dependencies. Scan those too so
        // a vulnerable package pulled in by another package is visible; direct
        // references still win when the same package/version appears in both.
        for (const project of projects) {
          const assetsPath = path.join(path.dirname(project.Path), "obj", "project.assets.json");
          try {
            const assets = JSON.parse(await fs.readFile(assetsPath, "utf8")) as {
              libraries?: Record<string, { type?: string }>;
              targets?: Record<string, Record<string, { dependencies?: Record<string, string> }>>;
            };
            const directIds = new Set(project.Packages.map((pkg) => pkg.Id.toLowerCase()));
            const parentsByChild = new Map<string, Set<string>>();
            for (const target of Object.values(assets.targets ?? {})) {
              for (const [parentKey, metadata] of Object.entries(target)) {
                const parentId = parentKey.slice(0, parentKey.lastIndexOf("/"));
                for (const childId of Object.keys(metadata.dependencies ?? {})) {
                  const child = childId.toLowerCase();
                  const parents = parentsByChild.get(child) ?? new Set<string>();
                  parents.add(parentId);
                  parentsByChild.set(child, parents);
                }
              }
            }

            for (const [libraryKey, library] of Object.entries(assets.libraries ?? {})) {
              if (library.type !== "package") continue;
              const slash = libraryKey.lastIndexOf("/");
              if (slash <= 0) continue;
              const id = libraryKey.slice(0, slash);
              const version = libraryKey.slice(slash + 1);
              const mapKey = `${id.toLowerCase()}::${version}`;
              const direct = directIds.has(id.toLowerCase());
              const dependencyOf = new Set(parentsByChild.get(id.toLowerCase()) ?? []);
              const existing = installedMap.get(mapKey);
              if (existing) {
                existing.direct = existing.direct || direct;
                dependencyOf.forEach((parent) => existing.dependencyOf.add(parent));
                if (!existing.projects.some((p) => p.Path === project.Path)) {
                  existing.projects.push({ Name: project.Name, Path: project.Path });
                }
              } else {
                installedMap.set(mapKey, {
                  id,
                  version,
                  projects: [{ Name: project.Name, Path: project.Path }],
                  frameworks: new Set(),
                  direct,
                  dependencyOf,
                });
              }
            }
          } catch {
            // No restore output (or an unreadable file): direct references only.
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
              const key = packageId.toLowerCase();
              const existing = allVulnerabilities.get(key) ?? [];
              existing.push(...entries);
              allVulnerabilities.set(key, existing);
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
              Id: installed.id,
              InstalledVersion: installed.version,
              Severity: worstMatch.severity,
              AdvisoryUrl: worstMatch.url,
              AffectedVersionRange: worstMatch.versions,
              Projects: installed.projects,
              ...(installed.frameworks.size > 0
                ? { CpmFrameworks: [...installed.frameworks].sort() }
                : {}),
              ...(!installed.direct ? { IsTransitive: true } : {}),
              ...(installed.dependencyOf.size > 0
                ? { DependencyOf: [...installed.dependencyOf].sort() }
                : {}),
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

    async consolidatePackagesAsync(request: ConsolidateRequest, signal?: AbortSignal): Promise<Result<void>> {
      Logger.info(
        `consolidatePackages: ${request.PackageId} to ${request.TargetVersion} across ${request.ProjectPaths.length} projects`
      );

      const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
      if (outsideWorkspace) {
        return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
      }

      if (!isValidPackageId(request.PackageId)) {
        return fail(`Invalid NuGet package ID: ${request.PackageId}`);
      }
      if (!isValidNuGetVersion(request.TargetVersion)) {
        return fail(`Invalid NuGet version: ${request.TargetVersion}`);
      }

      try {
        const changesByFile = new Map<string, CpmVersionChange[]>();
        const nonCpmProjects: string[] = [];
        const cpmMapCache = new Map<string, Promise<CpmPackageMap>>();

        for (const [i, projectPath] of request.ProjectPaths.entries()) {
          if (signal?.aborted) break;
          StatusBarUtils.ShowText(
            `Consolidating ${request.PackageId} (${i + 1}/${request.ProjectPaths.length})...`
          );

          const cpmFilePath = await CpmResolver.FindCpmFilePathAsync(projectPath);
          let cpmMap: CpmPackageMap | null = null;
          if (cpmFilePath) {
            if (!cpmMapCache.has(cpmFilePath)) {
              cpmMapCache.set(cpmFilePath, CpmResolver.ParseCpmFileAsync(cpmFilePath));
            }
            cpmMap = await cpmMapCache.get(cpmFilePath)!;
          }

          if (cpmMap && CpmResolver.HasPackage(cpmMap, request.PackageId)) {
            const conditionalGroups = cpmMap.conditional.filter((entry) =>
              [...entry.versions.keys()].some(
                (id) => id.toLowerCase() === request.PackageId.toLowerCase()
              )
            );

            // Consolidation is per framework line. A blanket scope would rewrite
            // every framework version of the package to one target, which is
            // exactly what multi-framework CPM files must avoid.
            if (
              (request.Scope === "all" || request.Scope === "first")
              && conditionalGroups.length > 0
            ) {
              throw new Error(
                `Package ${request.PackageId} has framework-scoped versions; consolidate one framework line at a time.`
              );
            }

            let condition = request.CpmCondition;
            let scope = request.Scope;

            if (condition === undefined && scope === undefined) {
              const unconditional = [...cpmMap.unconditional.keys()].some(
                (id) => id.toLowerCase() === request.PackageId.toLowerCase()
              );

              if (unconditional) {
                scope = "unconditional";
              } else if (conditionalGroups.length === 1 && conditionalGroups[0]) {
                condition = conditionalGroups[0].condition;
                scope = "group";
              } else {
                throw new Error(
                  `Package ${request.PackageId} has multiple framework-scoped versions; specify CpmCondition.`
                );
              }
            }

            const change: CpmVersionChange = {
              packageId: request.PackageId,
              version: request.TargetVersion,
              scope: scope ?? (condition ? "group" : "unconditional"),
            };
            if (condition !== undefined) {
              change.condition = condition;
            }
            const list = changesByFile.get(cpmFilePath!) ?? [];
            list.push(change);
            changesByFile.set(cpmFilePath!, list);
          } else {
            nonCpmProjects.push(projectPath);
          }
        }

        for (const [propsFilePath, changes] of changesByFile) {
          await CpmResolver.UpdateCpmVersionsAsync(propsFilePath, changes);
        }

        const skipRestoreConfig =
          !!vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager").get<string>("skipRestore");

        for (const projectPath of nonCpmProjects) {
          await executeAddPackage(request.PackageId, projectPath, request.TargetVersion, skipRestoreConfig, undefined, undefined, signal);
        }

        if (!skipRestoreConfig) {
          for (const projectPath of request.ProjectPaths) {
            await TaskExecutor.ExecuteCommandAsync(
              "dotnet",
              ["restore", projectPath.replace(/\\/g, "/")],
              `restore-${request.PackageId}`
            );
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

type FileSnapshot = {
  path: string;
  content: string | null;
};

async function snapshotFilesAsync(paths: string[]): Promise<Map<string, FileSnapshot>> {
  const snapshots = new Map<string, FileSnapshot>();
  for (const filePath of new Set(paths)) {
    try {
      snapshots.set(filePath, { path: filePath, content: await fs.readFile(filePath, "utf8") });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      snapshots.set(filePath, { path: filePath, content: null });
    }
  }
  return snapshots;
}

async function rollbackFilesAsync(
  snapshots: Map<string, FileSnapshot> | undefined
): Promise<string | undefined> {
  if (!snapshots) return undefined;
  const errors: string[] = [];
  for (const snapshot of snapshots.values()) {
    try {
      if (snapshot.content === null) {
        await fs.rm(snapshot.path, { force: true });
      } else {
        await fs.writeFile(snapshot.path, snapshot.content, "utf8");
      }
    } catch (err) {
      errors.push(`${snapshot.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors.length > 0 ? errors.join("; ") : undefined;
}

async function restoreProjectsInternalAsync(
  projectPaths: string[],
  signal: AbortSignal | undefined,
  allowConflictResolution: boolean
): Promise<string | null> {
  const failedPaths: string[] = [];
  for (const projectPath of [...new Set(projectPaths)]) {
    if (signal?.aborted) break;
    try {
      if (allowConflictResolution) {
        await restoreWithConflictResolutionAsync(projectPath, 0, signal);
      } else {
        await TaskExecutor.ExecuteCommandAsync(
          "dotnet",
          ["restore", projectPath.replace(/\\/g, "/")],
          `rollback-restore-${projectPath}`,
          signal
        );
      }
    } catch (err) {
      Logger.error(`restoreProjectsInternal: Failed to restore ${projectPath}`, err);
      failedPaths.push(projectPath);
    }
  }
  return failedPaths.length > 0
    ? `Restore failed for ${failedPaths.length} project(s).`
    : null;
}

/**
 * Removes a PackageVersion entry from every Directory.Packages.props file whose
 * projects no longer reference the package. Called after an uninstall so CPM
 * does not accumulate stale global references.
 */
async function buildCleanupReportAsync(signal?: AbortSignal): Promise<CleanupReport> {
  const settings = getCpmSettings();
  let projectFiles = await vscode.workspace.findFiles(
    "**/*.{csproj,fsproj,vbproj}",
    "**/node_modules/**"
  );
  projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);

  const used = new Map<string, string>();
  for (const file of projectFiles) {
    if (signal?.aborted) break;
    try {
      const project = await ProjectParser.ParseAsync(file.fsPath, null);
      for (const pkg of project.Packages) {
        used.set(pkg.Id.toLowerCase(), pkg.Id);
      }
    } catch (err) {
      // Do not produce a report that could delete a used package because one
      // project could not be read.
      throw new Error(`Failed to scan ${file.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let propsFiles = await vscode.workspace.findFiles(
    "**/Directory.Packages.props",
    "**/{bin,obj,node_modules,.git}/**"
  );
  propsFiles = applyExcludeGlobs(propsFiles, settings.excludeGlobs);

  const defined = new Map<string, string>();
  const propsReports: CleanupReport["PropsFiles"] = [];
  for (const file of propsFiles) {
    const map = await CpmResolver.ParseCpmFileAsync(file.fsPath);
    const definedHere = new Map<string, string>();
    for (const id of map.unconditional.keys()) definedHere.set(id.toLowerCase(), id);
    for (const entry of map.conditional) {
      for (const id of entry.versions.keys()) definedHere.set(id.toLowerCase(), id);
    }
    for (const [key, id] of definedHere) defined.set(key, id);

    const unused = [...definedHere.entries()]
      .filter(([key]) => !used.has(key))
      .map(([, id]) => id)
      .sort((a, b) => a.localeCompare(b));
    propsReports.push({
      Path: file.fsPath,
      Defined: [...definedHere.values()].sort((a, b) => a.localeCompare(b)),
      Unused: unused,
    });
  }

  const unused = [...defined.entries()]
    .filter(([key]) => !used.has(key))
    .map(([, id]) => id)
    .sort((a, b) => a.localeCompare(b));
  const missing = [...used.entries()]
    .filter(([key]) => !defined.has(key))
    .map(([, id]) => id)
    .sort((a, b) => a.localeCompare(b));

  return {
    PropsFiles: propsReports,
    Used: [...used.values()].sort((a, b) => a.localeCompare(b)),
    Missing: missing,
    Unused: unused,
  };
}

async function cleanupUnusedCpmPackageAsync(packageId: string, signal?: AbortSignal): Promise<void> {
  const settings = getCpmSettings();
  let projectFiles = await vscode.workspace.findFiles(
    "**/*.{csproj,fsproj,vbproj}",
    "**/node_modules/**"
  );
  projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);

  const cpmFiles = new Set<string>();
  const referencedCpmFiles = new Set<string>();

  for (const file of projectFiles) {
    if (signal?.aborted) return;
    const cpmFile = await CpmResolver.FindCpmFilePathAsync(file.fsPath);
    if (!cpmFile) continue;
    cpmFiles.add(cpmFile);

    try {
      const project = await ProjectParser.ParseAsync(file.fsPath, null);
      if (project.Packages.some((pkg) => pkg.Id.toLowerCase() === packageId.toLowerCase())) {
        referencedCpmFiles.add(cpmFile);
      }
    } catch (err) {
      // Be conservative: if a project cannot be parsed, never delete its CPM entry.
      Logger.warn(`cleanupUnusedCpmPackage: Could not parse ${file.fsPath}`, err);
      referencedCpmFiles.add(cpmFile);
    }
  }

  for (const cpmFile of cpmFiles) {
    if (referencedCpmFiles.has(cpmFile)) continue;
    try {
      await CpmResolver.RemovePackageVersionAsync(cpmFile, packageId);
    } catch (err) {
      Logger.error(`cleanupUnusedCpmPackage: Failed to clean ${cpmFile}`, err);
      throw err;
    }
  }
}

async function restoreWithConflictResolutionAsync(projectPath: string, attempt = 0, signal?: AbortSignal): Promise<void> {
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

    await restoreWithConflictResolutionAsync(projectPath, attempt + 1, signal);
  }
}

async function executeRemovePackage(packageId: string, projectPath: string, operationId?: string, signal?: AbortSignal): Promise<void> {
  StatusBarUtils.ShowText(`Removing package ${packageId}...`);
  const args = ["remove", projectPath.replace(/\\/g, "/"), "package", packageId];
  await TaskExecutor.ExecuteCommandAsync("dotnet", args, operationId ?? `remove-${packageId}`, signal);
}

async function executeAddPackage(
  packageId: string,
  projectPath: string,
  version?: string,
  skipRestore = false,
  sourceUrl?: string,
  operationId?: string,
  signal?: AbortSignal
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

  await TaskExecutor.ExecuteCommandAsync("dotnet", args, operationId ?? `add-${packageId}`, signal);
}

async function getLatestVersion(
  packageId: string,
  prerelease: boolean,
  sources: Array<{ Name: string; Url: string; Patterns?: string[] }>,
  signal?: AbortSignal
): Promise<{ version: string; versions: string[]; sourceUrl: string; sourceName: string } | null> {
  let best: { version: string; versions: string[]; sourceUrl: string; sourceName: string } | null = null;

  const mappedSources = sources.filter((source) => (source.Patterns?.length ?? 0) > 0);
  const candidates = mappedSources.length > 0
    ? sources.filter((source) =>
        source.Patterns?.some((pattern) => matchesPackagePattern(pattern, packageId))
      )
    : sources;

  const promises = candidates.map(async (source) => {
    try {
      const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
      const result = await api.GetPackagesAsync(packageId, prerelease, 0, 1, signal);
      const pkg = result.data.find((p) => p.Name.toLowerCase() === packageId.toLowerCase());
      if (pkg) {
        const versions = [...new Set([
          ...(pkg.Versions ?? []).map((v) => v.Version),
          ...(pkg.Version ? [pkg.Version] : []),
        ])].filter((version) => prerelease || !version.includes("-"));
        const sorted = versions.sort(compareVersions);
        return {
          version: sorted[sorted.length - 1] ?? pkg.Version,
          versions: sorted,
          sourceUrl: source.Url,
          sourceName: source.Name,
        };
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

/** Major version of a NuGet version string (empty for non-numeric versions). */
function getVersionMajor(version: string): number | null {
  const release = version.split("+")[0]!.split("-")[0]!;
  const match = /^(\d+)\./.exec(release);
  return match ? parseInt(match[1]!, 10) : null;
}

/** Highest version in the list that belongs to `major`, or null when none match. */
function getLatestInMajor(versions: string[], major: number): string | null {
  return (
    versions
      .filter((version) => getVersionMajor(version) === major)
      .sort(compareVersions)
      .at(-1) ?? null
  );
}
