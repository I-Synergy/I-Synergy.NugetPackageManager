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
  BatchUpdateConflict,
  CheckBatchUpdateResponse,
  JobRequest,
  GetJobResponse,
  StartJobResponse,
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
  GetOutdatedScanProgressRequest,
  GetOutdatedScanProgressResponse,
} from "@/common/rpc/types";
import type { Result } from "@/common/rpc/result";
import { ok, fail } from "@/common/rpc/result";
import ProjectParser from "./utilities/project-parser";
import CpmResolver, { type CpmPackageMap, type CpmVersionChange } from "./utilities/cpm-resolver";
import { getTfmMajorVersion } from "./utilities/cpm-condition";
import ProjectFrameworkResolver from "./utilities/project-framework-resolver";
import { findPathOutsideWorkspaceAsync } from "./utilities/workspace-path";
import { compareVersions, isVersionInRange, satisfiesVersionRange } from "./utilities/version";
import { isValidNuGetVersion, isValidPackageId } from "./utilities/nuget-identifier";
import {
  FormatRestoreConflicts,
  ParseRestoreConflicts,
  SummarizeRestoreFailure,
  type RestoreConflict,
} from "./utilities/restore-diagnostics";
import nugetApiFactory from "./nuget/api-factory";
import { SetUpdateBadge } from "./view-badge";
import NuGetConfigResolver from "./utilities/nuget-config-resolver";
import TaskExecutor, { DotnetError } from "./utilities/task-executor";
import StatusBarUtils from "./utilities/status-bar-utils";
import { Logger } from "../common/logger";
import { getConfiguration, getSetting } from "../common/configuration";
import { BuildScanCacheKey, ScanCacheStore } from "./scan-cache";
import { ScanProgress } from "./utilities/scan-progress";
import { OperationJobs, type JobReporter } from "./utilities/operation-jobs";
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
  return {
    alignedPatterns: getSetting<string[]>("frameworkAlignedPackages", DEFAULT_FRAMEWORK_ALIGNED_PATTERNS),
    extraTargetFrameworks: getSetting<string[]>("extraTargetFrameworks", []),
    excludeGlobs: getSetting<string[]>("excludeGlobs", []),
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

/** Keeps hidden/scratch directories out of every package and project scan. */
function isInternalExcludedPath(fsPath: string): boolean {
  const normalized = fsPath.replace(/\\/g, "/").toLowerCase();
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.fsPath.replace(/\\/g, "/").toLowerCase().replace(/\/$/, ""))
    .filter(Boolean);
  const root = workspaceRoots.find(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`)
  );
  const relative = root ? normalized.slice(root.length).replace(/^\/+/, "") : normalized;
  const segments = relative.split("/");
  // The final segment is the file; any hidden directory above it is excluded.
  return segments.slice(0, -1).some((segment) => segment.startsWith("."));
}

/** Excludes configured globs (for example bin and obj folders) from project discovery. */
function applyExcludeGlobs<T extends { fsPath: string }>(files: T[], excludeGlobs: string[]): T[] {
  const visibleFiles = files.filter((file) => !isInternalExcludedPath(file.fsPath));
  if (excludeGlobs.length === 0) return visibleFiles;
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
  return visibleFiles.filter((file) => {
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

/**
 * Shared implementation of the direct `batchUpdatePackagesAsync` RPC and the
 * background batch update job. `report` streams stage/percent to the job
 * registry so the webview can render progress without holding a request open.
 */
async function runBatchUpdateAsync(
  request: BatchUpdateRequest,
  signal?: AbortSignal,
  report: JobReporter = () => {}
): Promise<Result<BatchUpdateResponse>> {
  Logger.info(`batchUpdatePackages: Updating ${request.Updates.length} packages`);
  report("Preparing update…", 2);

  const outsideWorkspace = await findOutsideWorkspaceAsync(
    request.Updates.flatMap((update) => update.ProjectPaths)
  );
  if (outsideWorkspace) {
    return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
  }

  const results: Array<{ PackageId: string; Success: boolean; Error?: string }> = [];
  const configSkipRestore = getSetting<boolean>("skipRestore", false);
  const skipRestore = request.SkipRestore === true || configSkipRestore;
  const cpmMapCache = new Map<string, Promise<CpmPackageMap>>();
  const transactional = request.Transactional === true;
  const allProjectPaths = [...new Set(request.Updates.flatMap((update) => update.ProjectPaths))];
  let snapshots: Map<string, FileSnapshot> | undefined;

  report("Snapshotting files…", 3);
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

  report("Updating packages…", 5);
  let transactionFailed = false;
  for (const [i, update] of request.Updates.entries()) {
    if (signal?.aborted) break;
    report(
      `Updating ${update.PackageId} (${i + 1}/${request.Updates.length})…`,
      5 + (i / Math.max(1, request.Updates.length)) * 70
    );
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
        // A transactional batch restores once at the end; letting `dotnet add`
        // restore here would turn one restore into one per package.
        await executeAddPackage(
          update.PackageId,
          projectPath,
          update.Version,
          skipRestore || (transactional && !skipRestore),
          undefined,
          undefined,
          signal
        );
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

  if (signal?.aborted) {
    // An explicit cancel rolls back whatever the transaction already wrote; it
    // never leaves a partially applied update behind.
    transactionFailed = transactional;
  }

  if (transactional) {
    let restoreFailure: RestoreFailure | null = null;
    const restoreError = (): string | undefined => restoreFailure?.message;
    if (!transactionFailed && !skipRestore) {
      report("Restoring updated projects…", 80);
      StatusBarUtils.ShowText("Restoring updated projects...");
      restoreFailure = await restoreProjectsInternalAsync(
        allProjectPaths,
        signal,
        true,
        ({ projectPath, index, total, stage, percent }) => {
          // One long static bar makes a slow solution look hung; dotnet's own
          // stage keeps it moving and names the project being restored.
          const projectName = path.basename(projectPath);
          report(
            `${stage} — ${projectName} (${index + 1}/${total})`,
            80 + (15 * (index + percent / 100)) / Math.max(1, total)
          );
        }
      );
    }

    const failedRestore = restoreError();
    if (transactionFailed || failedRestore) {
      report("Rolling back…", 90);
      const conflictingPackages = attributeRestoreConflicts(restoreFailure, request.Updates);
      const rollbackError = await rollbackFilesAsync(snapshots);
      let rollbackRestoreError: string | undefined;
      if (!skipRestore && (transactionFailed || failedRestore)) {
        rollbackRestoreError = (await restoreProjectsInternalAsync(allProjectPaths, signal, false))?.message;
      }
      StatusBarUtils.hide();
      Logger.error("batchUpdatePackages: Transaction rolled back", failedRestore ?? "write failure");
      const response: BatchUpdateResponse = { Results: results, RolledBack: true };
      if (failedRestore) response.RestoreError = failedRestore;
      const rollbackMessage = rollbackError ?? rollbackRestoreError;
      if (rollbackMessage) response.RollbackError = rollbackMessage;
      if (conflictingPackages.length > 0) response.ConflictingPackages = conflictingPackages;
      if (signal?.aborted) response.Cancelled = true;
      return ok(response);
    }
  }

  StatusBarUtils.hide();
  report("Completed", 100);
  const response: BatchUpdateResponse = { Results: results };
  if (signal?.aborted) response.Cancelled = true;
  return ok(response);
}

/**
 * Shared implementation of `updateProjectAsync` and the project update job.
 * `report` streams stage/percent to the job registry.
 */
async function runProjectUpdateAsync(
  request: UpdateProjectRequest,
  signal?: AbortSignal,
  report: JobReporter = () => {}
): Promise<Result<UpdateProjectResponse>> {
  Logger.info(`updateProject: ${request.Type} ${request.PackageId} in ${request.ProjectPath}`);
  report("Preparing update…", 5);

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

  const skipRestoreConfig = getSetting<boolean>("skipRestore", false);
  const cpmMapBefore = await CpmResolver.GetFrameworkPackageMapAsync(request.ProjectPath);
  const isCpmEnabled = cpmMapBefore !== null;
  const isCpmPackage = cpmMapBefore !== null && CpmResolver.HasPackage(cpmMapBefore, request.PackageId);
  const skipRestore = !!skipRestoreConfig && !isCpmEnabled;

  // A single-package operation mutates at least the project file and, for
  // CPM, Directory.Packages.props. Uninstall can also prune other props
  // files, so snapshot all of them up front. A failed restore then leaves
  // the workspace exactly as it was, matching the batch path.
  report("Snapshotting files…", 10);
  const snapshotPaths = new Set<string>([request.ProjectPath]);
  const cpmFilePath = await CpmResolver.FindCpmFilePathAsync(request.ProjectPath);
  if (cpmFilePath) snapshotPaths.add(cpmFilePath);
  if (request.Type === "UNINSTALL" && isCpmEnabled) {
    const propsFiles = await vscode.workspace.findFiles(
      "**/Directory.Packages.props",
      "**/{bin,obj,node_modules,.git}/**"
    );
    for (const file of propsFiles) snapshotPaths.add(file.fsPath);
  }
  const snapshots = await snapshotFilesAsync([...snapshotPaths]);
  let writeAttempted = false;

  try {
    writeAttempted = true;
    report("Writing package reference…", 30);
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
        report("Restoring project…", 60);
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
    const detail = err instanceof DotnetError ? SummarizeRestoreFailure(err.output) : null;

    let rollbackError: string | undefined;
    if (writeAttempted) {
      report("Rolling back…", 90);
      rollbackError = await rollbackFilesAsync(snapshots);
      if (!skipRestore && !signal?.aborted) {
        // Best effort: bring the restored graph back in line with the
        // rolled-back files. A failure here is reported together with the
        // original error rather than masking it.
        const restoreFailure = await restoreProjectsInternalAsync([request.ProjectPath], signal, false);
        if (restoreFailure) {
          rollbackError = [rollbackError, restoreFailure.message].filter(Boolean).join("; ");
        }
      }
      Logger.error(`updateProject: Rolled back ${request.Type.toLowerCase()} of ${request.PackageId}`, err);
    }

    const action = request.Type === "UNINSTALL"
      ? "uninstall"
      : request.Type === "INSTALL"
        ? "install"
        : "update";
    const rollbackNote = writeAttempted
      ? rollbackError
        ? ` (rollback incomplete: ${rollbackError})`
        : " (rolled back)"
      : "";
    return fail(`Failed to ${action} package: ${detail ?? message}${rollbackNote}`);
  } finally {
    StatusBarUtils.hide();
  }

  nugetApiFactory.ClearCache();

  report("Refreshing project…", 95);
  const parsed = await parseProjectWithCpmAsync(request.ProjectPath, createCpmParseContext());
  const updatedProject = parsed.project;

  return ok({ Project: updatedProject, IsCpmEnabled: isCpmEnabled });
}
/**
 * Shared implementation of `cleanupUnusedPackagesAsync` and the cleanup job.
 * `report` streams stage/percent to the job registry.
 */
async function runCleanupAsync(
  signal?: AbortSignal,
  report: JobReporter = () => {}
): Promise<Result<CleanupUnusedResponse>> {
  try {
    report("Scanning projects for unused packages…", 5);
    const cleanupReport = await buildCleanupReportAsync(signal);
    const removed: string[] = [];
    const backups: string[] = [];
    const errors: string[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    for (const [i, propsFile] of cleanupReport.PropsFiles.entries()) {
      if (propsFile.Unused.length === 0) continue;
      report(
        `Cleaning ${propsFile.Path} (${i + 1}/${cleanupReport.PropsFiles.length})…`,
        10 + (i / Math.max(1, cleanupReport.PropsFiles.length)) * 80
      );
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

    return ok({ Report: cleanupReport, Removed: [...new Set(removed)], Backups: backups, Errors: errors });
  } catch (err) {
    return fail(`Failed to clean unused packages: ${err instanceof Error ? err.message : String(err)}`);
  }
}
/**
 * Shared implementation of `consolidatePackagesAsync` and the consolidation
 * job. `report` streams stage/percent to the job registry.
 */
async function runConsolidateAsync(
  request: ConsolidateRequest,
  signal?: AbortSignal,
  report: JobReporter = () => {}
): Promise<Result<void>> {
  Logger.info(
    `consolidatePackages: ${request.PackageId} to ${request.TargetVersion} across ${request.ProjectPaths.length} projects`
  );
  report("Preparing consolidation…", 5);

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
      report(
        `Consolidating ${request.PackageId} (${i + 1}/${request.ProjectPaths.length})…`,
        10 + (i / Math.max(1, request.ProjectPaths.length)) * 40
      );
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

    report("Writing package versions…", 60);
    for (const [propsFilePath, changes] of changesByFile) {
      await CpmResolver.UpdateCpmVersionsAsync(propsFilePath, changes);
    }

    const skipRestoreConfig = getSetting<boolean>("skipRestore", false);

    for (const projectPath of nonCpmProjects) {
      await executeAddPackage(request.PackageId, projectPath, request.TargetVersion, skipRestoreConfig, undefined, undefined, signal);
    }

    if (!skipRestoreConfig) {
      report("Restoring projects…", 70);
      for (const [i, projectPath] of request.ProjectPaths.entries()) {
        report(`Restoring project ${i + 1}/${request.ProjectPaths.length}…`, 70 + (i / Math.max(1, request.ProjectPaths.length)) * 25);
        await TaskExecutor.ExecuteCommandAsync(
          "dotnet",
          ["restore", projectPath.replace(/\\/g, "/")],
          `restore-${request.PackageId}`
        );
      }
    }

    StatusBarUtils.hide();
    report("Completed", 100);
    Logger.info(`consolidatePackages: Done`);
    return ok(undefined as void);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error(`consolidatePackages: Failed`, err);
    StatusBarUtils.hide();
    return fail(`Failed to consolidate: ${message}`);
  }
}


/**
 * Maps a restore failure back to the batch rows that most likely caused it.
 *
 * `dotnet restore` names the contested package and the dependency chains that
 * pin it. Any requested package that appears in either place is a suspect, so
 * the UI can offer "retry without these" instead of making the user re-select
 * 60 packages by hand.
 */
function attributeRestoreConflicts(
  failure: RestoreFailure | null,
  updates: BatchUpdateRequest["Updates"]
): string[] {
  if (!failure) return [];

  const requested = new Map(updates.map((update) => [update.PackageId.toLowerCase(), update.PackageId]));
  if (requested.size === 0) return [];

  const named = new Set<string>();
  for (const conflict of failure.conflicts) {
    if (conflict.packageId) named.add(conflict.packageId.toLowerCase());
    for (const constraint of conflict.constraints) {
      // Chains look like "Project -> Package 1.2.3 -> Other (>= 1.0)".
      for (const match of constraint.chain.matchAll(/([A-Za-z][\w.-]+)\s+v?\d+\.\d+/g)) {
        const candidate = match[1] ?? "";
        if (candidate) named.add(candidate.toLowerCase());
      }
    }
  }

  const suspects: string[] = [];
  for (const id of named) {
    const requestedId = requested.get(id);
    if (requestedId && !suspects.includes(requestedId)) suspects.push(requestedId);
  }
  return suspects;
}

/**
 * Checks the whole selected set against the dependency graph before anything is
 * written.
 *
 * Two directions matter:
 * 1. the ranges declared by each selected package's *new* version, evaluated
 *    against the versions the batch will leave in the graph;
 * 2. the ranges installed packages declare on the selected packages (skipping
 *    blockers that are themselves being updated, since their new metadata is
 *    already covered by (1)).
 *
 * Without a restored project (`project.assets.json`) there is no graph to check
 * against, so no conflict is reported; `dotnet restore` stays the authority.
 */
async function findBatchUpdateConflictsAsync(
  request: BatchUpdateRequest,
  signal?: AbortSignal
): Promise<BatchUpdateConflict[]> {
  const updates = request.Updates.filter((update) => update.Version);
  if (updates.length === 0) return [];

  const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(getWorkspaceRoots());
  const detailsCache = new Map<string, Promise<Record<string, PackageDependency[]> | null>>();
  const conflicts: BatchUpdateConflict[] = [];
  const seen = new Set<string>();

  const selectedByProject = new Map<string, Map<string, { id: string; version: string }>>();
  for (const update of updates) {
    for (const projectPath of update.ProjectPaths) {
      const selected = selectedByProject.get(projectPath) ?? new Map<string, { id: string; version: string }>();
      selected.set(update.PackageId.toLowerCase(), { id: update.PackageId, version: update.Version });
      selectedByProject.set(projectPath, selected);
    }
  }

  const addConflict = (conflict: BatchUpdateConflict): void => {
    const key = `${conflict.PackageId.toLowerCase()}|${conflict.BlockedByPackageId.toLowerCase()}|${conflict.RequiredRange}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push(conflict);
  };

  for (const [projectPath, selected] of selectedByProject) {
    if (signal?.aborted) break;
    const graph = await loadProjectDependencyGraphAsync(projectPath);
    // Without a restored graph there is nothing to compare a single update
    // against; only a multi-package selection can still conflict with itself.
    if (!graph && selected.size < 2) continue;

    const effective = new Map(graph?.packageVersions ?? []);
    for (const [id, entry] of selected) effective.set(id, entry.version);

    const tfms = [...(graph?.tfms ?? [])];

    // (1) Ranges declared by the target version of each selected package.
    for (const entry of selected.values()) {
      if (signal?.aborted) break;
      const frameworks = await fetchDependencyFrameworksAsync(
        entry.id,
        entry.version,
        sources,
        detailsCache,
        signal
      );
      if (!frameworks) continue;

      const dependencies = selectDependencyGroup(frameworks, tfms);
      if (!dependencies) continue;

      for (const dependency of dependencies) {
        const dependencyId = dependency.package.toLowerCase();
        const resolved = effective.get(dependencyId);
        if (!resolved) continue;
        if (satisfiesVersionRange(resolved, dependency.versionRange)) continue;

        const alsoSelected = selected.get(dependencyId);
        addConflict({
          PackageId: entry.id,
          RequestedVersion: entry.version,
          BlockedByPackageId: dependency.package,
          BlockedByVersion: resolved,
          RequiredRange: dependency.versionRange,
          EffectiveVersion: resolved,
          ProjectPath: projectPath,
          Reason: alsoSelected
            ? `${entry.id} ${entry.version} requires ${dependency.package} ${dependency.versionRange}, but the batch selects ${alsoSelected.version}`
            : `${entry.id} ${entry.version} requires ${dependency.package} ${dependency.versionRange}, but the graph resolves ${resolved}`,
        });
      }
    }

    // (2) Ranges installed packages declare on the selected packages.
    if (graph) {
      // The assets graph is lowercased; keep the project file's casing so the
      // conflict names the package the way the user sees it.
      const direct = new Map<string, { id: string; versions: Set<string> }>();
      try {
        const parsedProject = await ProjectParser.ParseAsync(projectPath, null);
        for (const pkg of parsedProject.Packages) {
          direct.set(pkg.Id.toLowerCase(), { id: pkg.Id, versions: new Set([pkg.Version]) });
        }
      } catch (err) {
        Logger.debug(`checkBatchUpdate: could not parse ${projectPath} for display names`, err);
      }

      const group: InstalledPackageGroup = {
        tfms: new Set(graph.tfms),
        projectPaths: new Set([projectPath]),
        direct,
      };
      const constraintsByPackage = await collectGroupConstraintsAsync(
        [...selected.keys()],
        group,
        sources,
        detailsCache,
        signal
      );

      for (const [candidateId, constraints] of constraintsByPackage) {
        const entry = selected.get(candidateId);
        if (!entry) continue;
        const resolved = effective.get(candidateId) ?? entry.version;

        for (const constraint of constraints) {
          if (selected.has(constraint.PackageId.toLowerCase())) continue;
          if (satisfiesVersionRange(resolved, constraint.Range)) continue;
          addConflict({
            PackageId: entry.id,
            RequestedVersion: entry.version,
            BlockedByPackageId: constraint.PackageId,
            BlockedByVersion: constraint.InstalledVersion,
            RequiredRange: constraint.Range,
            EffectiveVersion: resolved,
            ProjectPath: projectPath,
            Reason: `${constraint.PackageId} ${constraint.InstalledVersion} requires ${entry.id} ${constraint.Range}`,
          });
        }
      }
    }
  }

  return conflicts;
}

export function createHostAPI(context?: vscode.ExtensionContext): HostAPI {
  const scanCache = new ScanCacheStore(context?.workspaceState);
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
      return runProjectUpdateAsync(request, signal);
    },

    async getConfigurationAsync(): Promise<Result<GetConfigurationResponse>> {
      Logger.info("getConfiguration: Retrieving configuration");

      const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
      const sourcesWithCreds = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

      const sources: Source[] = sourcesWithCreds.map((s) => ({
        Name: s.Name,
        Url: s.Url,
      }));

      const vscodeSourcesRaw = getSetting<string[]>("sources", []);
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
          SkipRestore: getSetting<boolean>("skipRestore", false),
          EnablePackageVersionInlineInfo: getSetting<boolean>("enablePackageVersionInlineInfo", false),
          Prerelease: getSetting<boolean>("prerelease", false),
          Sources: sources,
          StatusBarLoadingIndicator: getSetting<boolean>("statusBarLoadingIndicator", false),
        },
      });
    },

    async updateConfigurationAsync(request: UpdateConfigurationRequest): Promise<Result<void>> {
      Logger.info("updateConfiguration: Updating configuration");
      const config = getConfiguration();

      const sources = request.Configuration.Sources.map((x) =>
        JSON.stringify({
          name: x.Name,
          url: x.Url,
          ...(x.PasswordScriptPath && { passwordScriptPath: x.PasswordScriptPath }),
        })
      );

      if (getSetting<boolean>("skipRestore", false) !== request.Configuration.SkipRestore) {
        await config.update("skipRestore", request.Configuration.SkipRestore, vscode.ConfigurationTarget.Global);
      }
      if (getSetting<boolean>("enablePackageVersionInlineInfo", false) !== request.Configuration.EnablePackageVersionInlineInfo) {
        await config.update("enablePackageVersionInlineInfo", request.Configuration.EnablePackageVersionInlineInfo, vscode.ConfigurationTarget.Global);
      }
      if (getSetting<boolean>("prerelease", false) !== request.Configuration.Prerelease) {
        await config.update("prerelease", request.Configuration.Prerelease, vscode.ConfigurationTarget.Global);
      }
      const currentSources = getSetting<string[]>("sources", []);
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
      const scanStarted = Date.now();
      const scanId = request.ScanId;
      const report = (stage: string, percent: number, completed = 0, total = 0): void => {
        if (scanId) ScanProgress.Report(scanId, stage, percent, completed, total);
      };

      if (request.ProjectPaths?.length) {
        const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
        if (outsideWorkspace) {
          StatusBarUtils.hide();
          return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
        }
      }

      if (request.ForceReload) {
        nugetApiFactory.ClearCache(true);
      }

      try {
        if (scanId) ScanProgress.Begin(scanId, "Resolving package sources…");
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        let sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

        if (request.SourceUrl) {
          sources = sources.filter((s) => s.Url === request.SourceUrl);
        }

        if (sources.length === 0) {
          return ok({ Packages: [] });
        }

        const settings = getCpmSettings();

        const cacheKey = BuildScanCacheKey({
          workspaceRoots,
          projectPaths: request.ProjectPaths ?? [],
          sourceUrls: sources.map((source) => source.Url),
          prerelease: request.Prerelease,
          excludeGlobs: settings.excludeGlobs,
        });

        if (request.PreferCache && !request.ForceReload) {
          const cached = await scanCache.LoadAsync(cacheKey);
          StatusBarUtils.hide();
          if (!cached) return ok({ Packages: [], FromCache: true });
          const cachedResponse: GetOutdatedPackagesResponse = {
            Packages: cached.Packages,
            FromCache: true,
            ScannedAt: cached.ScannedAt,
          };
          if (cached.BlockedPackages.length > 0) cachedResponse.BlockedPackages = cached.BlockedPackages;
          Logger.info(`getOutdatedPackages: Served ${cached.Packages.length} package(s) from the last scan`);
          return ok(cachedResponse);
        }

        report("Reading project files…", 4);
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

        const parseStarted = Date.now();
        const totalProjects = projectFiles.length;
        let parsedProjects = 0;
        report(`Parsing projects (0/${totalProjects})…`, 4, 0, totalProjects);
        const parseResults = await Promise.allSettled(
          projectFiles.map(async (file) => {
            try {
              return await parseProjectWithCpmAsync(file.fsPath, cpmContext);
            } finally {
              parsedProjects += 1;
              report(
                `Parsing projects (${parsedProjects}/${totalProjects})…`,
                4 + (26 * parsedProjects) / Math.max(1, totalProjects),
                parsedProjects,
                totalProjects
              );
            }
          })
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

        const tfmSources = new Map<string, number>();
        for (const project of projects) {
          const source = project.TfmSource ?? "unknown";
          tfmSources.set(source, (tfmSources.get(source) ?? 0) + 1);
        }
        Logger.info(
          `getOutdatedPackages: Parsed ${projects.length} project(s) in ${Date.now() - parseStarted}ms` +
          ` (TFM sources: ${[...tfmSources].map(([source, count]) => `${source}=${count}`).join(", ") || "none"})`
        );

        const installedMap = new Map<string, InstalledPackageEntry>();

        // Direct packages per condition group. Used to work out which of them
        // declare a version range on a package we are about to suggest.
        const groups = new Map<string, InstalledPackageGroup>();

        for (const project of projects) {
          for (const pkg of project.Packages) {
            if (pkg.IsPinned) continue;

            // A package with framework-scoped versions intentionally has no
            // single `pkg.Version`; use its per-TFM resolutions instead of
            // dropping it from the Updates tab.
            const resolutions = pkg.CpmResolutions?.length
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

              let group = groups.get(resolution.Condition);
              if (!group) {
                group = { tfms: new Set(), projectPaths: new Set(), direct: new Map() };
                groups.set(resolution.Condition, group);
              }
              const idKey = pkg.Id.toLowerCase();
              let direct = group.direct.get(idKey);
              if (!direct) {
                direct = { id: pkg.Id, versions: new Set() };
                group.direct.set(idKey, direct);
              }
              direct.versions.add(resolution.Version);
              group.projectPaths.add(project.Path);
              if (resolution.Tfm) group.tfms.add(resolution.Tfm);
              for (const tfm of project.TargetFrameworks ?? []) group.tfms.add(tfm);
            }
          }
        }

        Logger.info(`getOutdatedPackages: ${installedMap.size} unique packages to check`);

        const installedKeys = Array.from(installedMap.keys());
        const configuredConcurrency = getSetting<number>("updateCheckConcurrency", 8);
        const batchSize = Number.isFinite(configuredConcurrency)
          ? Math.min(32, Math.max(1, Math.trunc(configuredConcurrency)))
          : 8;
        const latestCache = new Map<string, Promise<Awaited<ReturnType<typeof getLatestVersion>>>>();
        const candidates: OutdatedCandidate[] = [];
        const latestStarted = Date.now();
        report(`Checking latest versions (0/${installedKeys.length})…`, 30, 0, installedKeys.length);

        for (let i = 0; i < installedKeys.length; i += batchSize) {
          if (signal?.aborted) break;
          const batch = installedKeys.slice(i, i + batchSize);
          const checked = i + batch.length;
          const progress = Math.round((checked / installedKeys.length) * 100);
          StatusBarUtils.show(progress, `Checking updates (${checked}/${installedKeys.length})...`);
          report(
            `Checking latest versions (${checked}/${installedKeys.length})…`,
            30 + (60 * checked) / Math.max(1, installedKeys.length),
            checked,
            installedKeys.length
          );

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
            // Search results occasionally omit the version list; the reported
            // latest version must still be considered.
            const allVersions = latest.versions.length > 0 ? latest.versions : [latest.version];
            const alignedVersions = aligned && tfmMajor !== null
              ? allVersions.filter((version) => getVersionMajor(version) === tfmMajor)
              : allVersions;
            // Keep the historical fallback: when the TFM's major line has no
            // newer version, the overall latest is still offered (as
            // LatestOverallVersion) instead of hiding the update.
            const pool = alignedVersions.some((version) => compareVersions(version, installed.version) > 0)
              ? alignedVersions
              : allVersions;
            const available = pool
              .filter((version) => compareVersions(version, installed.version) > 0)
              .sort(compareVersions);
            if (available.length === 0) return;

            candidates.push({ packageId, installed, latest, available });
          });

          await Promise.allSettled(promises);
        }
        Logger.info(
          `getOutdatedPackages: Latest-version checks took ${Date.now() - latestStarted}ms for ${installedKeys.length} package(s)`
        );

        // Resolve the declared ranges once per condition group, then cap every
        // suggestion to the highest version those ranges accept. A provider
        // package such as Npgsql.EntityFrameworkCore.PostgreSQL declares an
        // exact pin on Microsoft.EntityFrameworkCore.Relational; offering the
        // next EF Core build would make the project unrestorable.
        const outdated: OutdatedPackage[] = [];
        const blocked: NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]> = [];
        const dependencyDetailsCache = new Map<string, Promise<Record<string, PackageDependency[]> | null>>();

        const candidatesByCondition = new Map<string, OutdatedCandidate[]>();
        for (const candidate of candidates) {
          const list = candidatesByCondition.get(candidate.installed.condition) ?? [];
          list.push(candidate);
          candidatesByCondition.set(candidate.installed.condition, list);
        }

        const constraintStarted = Date.now();
        const totalConditions = candidatesByCondition.size;
        let completedConditions = 0;
        report(`Checking dependency constraints (0/${totalConditions})…`, 90, 0, totalConditions);
        for (const [condition, conditionCandidates] of candidatesByCondition) {
          if (signal?.aborted) break;
          const constraintsByPackage = await collectGroupConstraintsAsync(
            conditionCandidates.map((candidate) => candidate.packageId),
            groups.get(condition),
            sources,
            dependencyDetailsCache,
            signal
          );
          completedConditions += 1;
          report(
            `Checking dependency constraints (${completedConditions}/${totalConditions})…`,
            90 + (8 * completedConditions) / Math.max(1, totalConditions),
            completedConditions,
            totalConditions
          );

          for (const candidate of conditionCandidates) {
            const constraints = constraintsByPackage.get(candidate.packageId.toLowerCase()) ?? [];
            const latestAvailable = candidate.available[candidate.available.length - 1]!;
            const satisfying = constraints.length === 0
              ? latestAvailable
              : candidate.available
                  .filter((version) => constraints.every((constraint) => satisfiesVersionRange(version, constraint.Range)))
                  .pop() ?? null;

            if (!satisfying || compareVersions(satisfying, candidate.installed.version) <= 0) {
              const reason = formatConstraintReason(constraints);
              blocked.push({
                Id: candidate.packageId,
                InstalledVersion: candidate.installed.version,
                BlockedVersion: latestAvailable,
                Reason: reason,
                BlockedBy: constraints.map((constraint) => ({
                  PackageId: constraint.PackageId,
                  InstalledVersion: constraint.InstalledVersion,
                  Range: constraint.Range,
                })),
              });
              Logger.info(
                `getOutdatedPackages: Holding ${candidate.packageId} at ${candidate.installed.version} — ${reason}`
              );
              continue;
            }

            const outdatedEntry: OutdatedPackage = {
              Id: candidate.packageId,
              InstalledVersion: candidate.installed.version,
              LatestVersion: satisfying,
              Projects: candidate.installed.projects,
              SourceUrl: candidate.latest.sourceUrl,
              SourceName: candidate.latest.sourceName,
            };
            if (candidate.installed.condition) outdatedEntry.CpmCondition = candidate.installed.condition;
            if (candidate.installed.framework) outdatedEntry.CpmFramework = candidate.installed.framework;
            if (candidate.installed.conditionLabel) outdatedEntry.CpmConditionLabel = candidate.installed.conditionLabel;
            if (!candidate.installed.matched) outdatedEntry.CpmMatched = false;
            if (compareVersions(candidate.latest.version, satisfying) > 0) {
              outdatedEntry.LatestOverallVersion = candidate.latest.version;
            }

            const violated = constraints.filter(
              (constraint) => !satisfiesVersionRange(candidate.latest.version, constraint.Range)
            );
            if (violated.length > 0) {
              outdatedEntry.BlockedBy = violated.map((constraint) => ({
                PackageId: constraint.PackageId,
                InstalledVersion: constraint.InstalledVersion,
                Range: constraint.Range,
              }));
            }

            outdated.push(outdatedEntry);
          }
        }

        outdated.sort((a, b) => a.Id.localeCompare(b.Id));
        blocked.sort((a, b) => a.Id.localeCompare(b.Id));
        report("Preparing results…", 99);
        Logger.info(
          `getOutdatedPackages: Dependency-constraint checks took ${Date.now() - constraintStarted}ms`
        );
        Logger.info(
          `getOutdatedPackages: Found ${outdated.length} outdated packages, ${blocked.length} held back in ${Date.now() - scanStarted}ms total`
        );
        await scanCache.SaveAsync({
          Key: cacheKey,
          ScannedAt: new Date().toISOString(),
          Packages: outdated,
          BlockedPackages: blocked,
        });
        const response: GetOutdatedPackagesResponse = { Packages: outdated };
        if (blocked.length > 0) response.BlockedPackages = blocked;
        return ok(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("getOutdatedPackages: Failed", err);
        return fail(`Failed to check for outdated packages: ${message}`);
      } finally {
        if (scanId) ScanProgress.Complete(scanId);
        StatusBarUtils.hide();
      }
    },

    async batchUpdatePackagesAsync(request: BatchUpdateRequest, signal?: AbortSignal): Promise<Result<BatchUpdateResponse>> {
      return runBatchUpdateAsync(request, signal);
    },

    async checkBatchUpdateAsync(
      request: BatchUpdateRequest,
      signal?: AbortSignal
    ): Promise<Result<CheckBatchUpdateResponse>> {
      if (!Array.isArray(request.Updates) || request.Updates.length === 0) {
        return ok({ Conflicts: [] });
      }

      const outsideWorkspace = await findOutsideWorkspaceAsync(
        request.Updates.flatMap((update) => update.ProjectPaths)
      );
      if (outsideWorkspace) {
        return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
      }

      try {
        const conflicts = await findBatchUpdateConflictsAsync(request, signal);
        Logger.info(
          `checkBatchUpdate: ${conflicts.length} conflict(s) across ${request.Updates.length} update(s)`
        );
        return ok({ Conflicts: conflicts });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("checkBatchUpdate: Failed", err);
        return fail(`Failed to check the update set: ${message}`);
      }
    },

    async startBatchUpdateAsync(request: BatchUpdateRequest): Promise<Result<StartJobResponse>> {
      if (!Array.isArray(request.Updates) || request.Updates.length === 0) {
        return fail("No packages to update");
      }
      if (OperationJobs.Batch.HasRunning()) {
        // Two interleaved transactions would let one job's rollback undo
        // another job's writes.
        return fail("Another update is already running. Wait for it to finish.");
      }

      const jobId = globalThis.crypto.randomUUID();
      OperationJobs.Batch.Start(jobId, (jobSignal, jobReport) => runBatchUpdateAsync(request, jobSignal, jobReport));
      Logger.info(`batchUpdatePackages: Started job ${jobId} for ${request.Updates.length} packages`);
      return ok({ JobId: jobId });
    },

    async startProjectUpdateAsync(request: UpdateProjectRequest): Promise<Result<StartJobResponse>> {
      const jobId = globalThis.crypto.randomUUID();
      OperationJobs.Project.Start(jobId, (jobSignal, jobReport) => runProjectUpdateAsync(request, jobSignal, jobReport));
      Logger.info(`updateProject: Started job ${jobId} for ${request.Type} ${request.PackageId}`);
      return ok({ JobId: jobId });
    },

    async startConsolidateAsync(request: ConsolidateRequest): Promise<Result<StartJobResponse>> {
      const jobId = globalThis.crypto.randomUUID();
      OperationJobs.Consolidate.Start(jobId, (jobSignal, jobReport) => runConsolidateAsync(request, jobSignal, jobReport));
      Logger.info(`consolidatePackages: Started job ${jobId} for ${request.PackageId}`);
      return ok({ JobId: jobId });
    },

    async startCleanupAsync(_request: CleanupUnusedRequest): Promise<Result<StartJobResponse>> {
      const jobId = globalThis.crypto.randomUUID();
      OperationJobs.Cleanup.Start(jobId, (jobSignal, jobReport) => runCleanupAsync(jobSignal, jobReport));
      Logger.info(`cleanupUnusedPackages: Started job ${jobId}`);
      return ok({ JobId: jobId });
    },

    async getJobAsync(request: JobRequest): Promise<Result<GetJobResponse>> {
      const status = OperationJobs.Get(request.JobId);
      if (!status) return fail(`Unknown job: ${request.JobId}`);
      return ok(status);
    },

    async cancelJobAsync(request: JobRequest): Promise<Result<void>> {
      if (!OperationJobs.Cancel(request.JobId)) {
        return fail(`Job is not running: ${request.JobId}`);
      }
      Logger.info(`cancelJob: Cancel requested for job ${request.JobId}`);
      return ok(undefined);
    },

    async updateBadgeAsync(request: UpdateBadgeRequest): Promise<Result<void>> {
      SetUpdateBadge(request.Count, request.BlockedCount ?? 0);
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
      return runCleanupAsync(signal);
    },

    async restoreProjectsAsync(request: RestoreProjectsRequest, signal?: AbortSignal): Promise<Result<void>> {
      const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
      if (outsideWorkspace) {
        return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
      }

      const configSkipRestore = getSetting<boolean>("skipRestore", false);
      if (configSkipRestore) {
        Logger.info("restoreProjects: skipped (skipRestore setting is enabled)");
        return ok(undefined);
      }

      const uniquePaths = [...new Set(request.ProjectPaths)];
      Logger.info(`restoreProjects: Restoring ${uniquePaths.length} project(s)`);
      StatusBarUtils.ShowText("Restoring packages...");
      let failure: RestoreFailure | null;
      try {
        failure = await restoreProjectsInternalAsync(uniquePaths, signal, true);
      } finally {
        StatusBarUtils.hide();
      }
      if (failure) {
        return fail(failure.message);
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

    async getOutdatedScanProgressAsync(request: GetOutdatedScanProgressRequest): Promise<Result<GetOutdatedScanProgressResponse>> {
      const progress = ScanProgress.Get(request.ScanId);
      if (progress === null) {
        return ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false });
      }
      return ok({ ...progress, Active: true });
    },

    async consolidatePackagesAsync(request: ConsolidateRequest, signal?: AbortSignal): Promise<Result<void>> {
      return runConsolidateAsync(request, signal);
    },
  };
}

// ============================================================
// Shared Helpers
// ============================================================

type RestoreFailure = {
  projectPaths: string[];
  conflicts: RestoreConflict[];
  message: string;
};

type RestoreProgress = {
  projectPath: string;
  index: number;
  total: number;
  stage: string;
  percent: number;
};


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
  allowConflictResolution: boolean,
  onProgress?: (progress: RestoreProgress) => void
): Promise<RestoreFailure | null> {
  const failedPaths: string[] = [];
  const conflicts: RestoreConflict[] = [];
  const summaries: string[] = [];
  const uniquePaths = [...new Set(projectPaths)];

  for (const [index, projectPath] of uniquePaths.entries()) {
    if (signal?.aborted) break;
    const reportProgress = (progress: { stage: string; percent: number }): void => {
      onProgress?.({
        projectPath,
        index,
        total: uniquePaths.length,
        stage: progress.stage,
        percent: progress.percent,
      });
    };
    try {
      if (allowConflictResolution) {
        await restoreWithConflictResolutionAsync(projectPath, 0, signal, reportProgress);
      } else {
        await TaskExecutor.ExecuteCommandAsync(
          "dotnet",
          ["restore", projectPath.replace(/\\/g, "/")],
          `rollback-restore-${projectPath}`,
          signal,
          undefined,
          reportProgress
        );
      }
    } catch (err) {
      Logger.error(`restoreProjectsInternal: Failed to restore ${projectPath}`, err);
      failedPaths.push(projectPath);
      if (err instanceof DotnetError) {
        conflicts.push(...ParseRestoreConflicts(err.output));
        const summary = SummarizeRestoreFailure(err.output);
        if (summary) summaries.push(summary);
      } else {
        summaries.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (failedPaths.length === 0) return null;

  const details = conflicts.length > 0
    ? FormatRestoreConflicts(conflicts)
    : [...new Set(summaries)].slice(0, 3).join(" | ");
  return {
    projectPaths: failedPaths,
    conflicts,
    message: `Restore failed for ${failedPaths.length} project(s)${details ? `: ${details}` : "."}`,
  };
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

async function restoreWithConflictResolutionAsync(
  projectPath: string,
  attempt = 0,
  signal?: AbortSignal,
  onProgress?: (progress: { stage: string; percent: number }) => void
): Promise<void> {
  const MAX_ATTEMPTS = 2;
  try {
    await TaskExecutor.ExecuteCommandAsync(
      "dotnet",
      ["restore", projectPath.replace(/\\/g, "/")],
      `restore-${projectPath}`,
      signal,
      undefined,
      onProgress
    );
  } catch (err) {
    if (!(err instanceof DotnetError) || attempt >= MAX_ATTEMPTS) {
      throw err;
    }

    // Only a package downgrade has an unambiguous automatic remedy (reference
    // the higher version). NU1107 conflicts between an exact pin and a lower
    // bound have no single correct answer, so they are reported instead of
    // rewritten.
    const conflicts = ParseRestoreConflicts(err.output)
      .filter((conflict) => conflict.code === "NU1605" || conflict.code === "NU1109")
      .filter((conflict) => conflict.packageId && conflict.suggestedVersion);
    if (conflicts.length === 0) {
      throw err;
    }

    Logger.info(`restoreWithConflictResolution: Detected ${conflicts.length} NU1605 conflict(s) in ${projectPath}, applying fixes`);

    const cpmVersions = await CpmResolver.GetPackageVersionsAsync(projectPath);
    let fixedAny = false;

    for (const { packageId, suggestedVersion } of conflicts) {
      const requiredVersion = suggestedVersion!;
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

// ============================================================
// Update-suggestion constraints
// ============================================================

type InstalledPackageEntry = {
  version: string;
  condition: string;
  framework: string;
  conditionLabel: string;
  matched: boolean;
  projects: Array<{ Name: string; Path: string; Version: string }>;
};

type InstalledPackageGroup = {
  tfms: Set<string>;
  projectPaths: Set<string>;
  direct: Map<string, { id: string; versions: Set<string> }>;
};

type OutdatedCandidate = {
  packageId: string;
  installed: InstalledPackageEntry;
  latest: { version: string; versions: string[]; sourceUrl: string; sourceName: string };
  available: string[];
};

type PackageConstraint = {
  PackageId: string;
  InstalledVersion: string;
  Range: string;
};

type ProjectDependencyGraph = {
  /** Installed version per package id (lowercased), from project.assets.json. */
  packageVersions: Map<string, string>;
  /** Parent -> child edges, both lowercased. */
  parentsByChild: Map<string, Set<string>>;
  /** Target frameworks restored into this assets file, e.g. `net11.0`. */
  tfms: Set<string>;
};

async function loadProjectDependencyGraphAsync(projectPath: string): Promise<ProjectDependencyGraph | null> {
  const assetsPath = path.join(path.dirname(projectPath), "obj", "project.assets.json");
  try {
    const assets = JSON.parse(await fs.readFile(assetsPath, "utf8")) as {
      libraries?: Record<string, { type?: string }>;
      targets?: Record<string, Record<string, { dependencies?: Record<string, string> }>>;
    };

    const packageVersions = new Map<string, string>();
    for (const [libraryKey, library] of Object.entries(assets.libraries ?? {})) {
      if (library.type !== "package") continue;
      const slash = libraryKey.lastIndexOf("/");
      if (slash <= 0) continue;
      packageVersions.set(libraryKey.slice(0, slash).toLowerCase(), libraryKey.slice(slash + 1));
    }

    const parentsByChild = new Map<string, Set<string>>();
    const tfms = new Set<string>();
    for (const [targetKey, target] of Object.entries(assets.targets ?? {})) {
      tfms.add(targetKey);
      for (const [parentKey, metadata] of Object.entries(target)) {
        const slash = parentKey.lastIndexOf("/");
        if (slash <= 0) continue;
        const parentId = parentKey.slice(0, slash).toLowerCase();
        for (const childId of Object.keys(metadata.dependencies ?? {})) {
          const child = childId.toLowerCase();
          const parents = parentsByChild.get(child) ?? new Set<string>();
          parents.add(parentId);
          parentsByChild.set(child, parents);
        }
      }
    }

    return { packageVersions, parentsByChild, tfms };
  } catch (err) {
    Logger.debug(`getOutdatedPackages: no dependency graph for ${projectPath}`, err);
    return null;
  }
}

/**
 * Picks the dependency group that applies to one of the given target
 * frameworks. Returns null when no group matches, which callers must treat as
 * "no constraint" rather than guessing with another framework's ranges.
 */
function selectDependencyGroup(
  frameworks: Record<string, PackageDependency[]>,
  tfms: string[]
): PackageDependency[] | null {
  const keys = Object.keys(frameworks);
  if (keys.length === 0) return null;

  for (const tfm of tfms) {
    const exact = keys.find((key) => key.toLowerCase() === tfm.toLowerCase());
    if (exact) return frameworks[exact] ?? null;
  }

  for (const tfm of tfms) {
    const major = getTfmMajorVersion(tfm);
    if (major === null) continue;
    const sameMajor = keys.find(
      (key) => key.toLowerCase().startsWith("net") && getTfmMajorVersion(key) === major
    );
    if (sameMajor) return frameworks[sameMajor] ?? null;
  }

  return null;
}

/** Resolves the declared dependency ranges of one exact package version. */
async function fetchDependencyFrameworksAsync(
  packageId: string,
  version: string,
  sources: Array<{ Url: string }>,
  cache: Map<string, Promise<Record<string, PackageDependency[]> | null>>,
  signal?: AbortSignal
): Promise<Record<string, PackageDependency[]> | null> {
  const cacheKey = `${packageId.toLowerCase()}@${version}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const pending = (async () => {
    for (const source of sources) {
      try {
        const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
        const pkg = await api.GetPackageAsync(packageId, true, signal);
        const versionEntry = pkg.data?.Versions.find(
          (entry) => compareVersions(entry.Version, version) === 0
        );
        if (!versionEntry) continue;
        const details = await api.GetPackageDetailsAsync(versionEntry.Id, signal);
        return details.data.dependencies.frameworks;
      } catch (err) {
        Logger.debug(
          `getOutdatedPackages: dependency metadata unavailable for ${packageId} ${version}`,
          err
        );
      }
    }
    return null;
  })();

  cache.set(cacheKey, pending);
  return pending;
}

/**
 * Collects the ranges that installed packages declare on the candidate
 * packages in one condition group.
 *
 * The graph comes from `project.assets.json`: it tells us which installed
 * packages transitively pull in a candidate. Only those packages' metadata is
 * fetched, which is what makes this cheap enough to run during a scan.
 * Without restore output there is no graph, and the check is skipped (the
 * restore/rollback path still protects the workspace).
 */
async function collectGroupConstraintsAsync(
  packageIds: string[],
  group: InstalledPackageGroup | undefined,
  sources: Array<{ Url: string }>,
  detailsCache: Map<string, Promise<Record<string, PackageDependency[]> | null>>,
  signal?: AbortSignal
): Promise<Map<string, PackageConstraint[]>> {
  const result = new Map<string, PackageConstraint[]>();
  if (!group || packageIds.length === 0) return result;

  const graphs = (await Promise.all(
    [...group.projectPaths].map((projectPath) => loadProjectDependencyGraphAsync(projectPath))
  )).filter((graph): graph is ProjectDependencyGraph => graph !== null);

  if (graphs.length === 0) {
    Logger.debug("getOutdatedPackages: no project.assets.json found — skipping dependency constraint check");
    return result;
  }

  const packageVersions = new Map<string, string>();
  const parentsByChild = new Map<string, Set<string>>();
  const tfms = new Set<string>(group.tfms);
  for (const graph of graphs) {
    for (const [id, version] of graph.packageVersions) {
      if (!packageVersions.has(id)) packageVersions.set(id, version);
    }
    for (const [child, parents] of graph.parentsByChild) {
      const merged = parentsByChild.get(child) ?? new Set<string>();
      for (const parent of parents) merged.add(parent);
      parentsByChild.set(child, merged);
    }
    // The assets targets are the authoritative TFM list after a restore; this
    // also covers projects where the package parser could not read a TFM.
    for (const tfm of graph.tfms) tfms.add(tfm);
  }

  // Only packages that declare a dependency edge to a candidate can constrain
  // it. The assets graph already tells us exactly who those parents are, so
  // there is no need to walk or fetch metadata for the whole closure.
  const candidateIds = new Set(packageIds.map((packageId) => packageId.toLowerCase()));
  const sourcesToFetch = new Set<string>();
  for (const candidateId of candidateIds) {
    for (const parent of parentsByChild.get(candidateId) ?? []) {
      if (packageVersions.has(parent)) sourcesToFetch.add(parent);
    }
  }

  const sourceIds = [...sourcesToFetch];
  const batchSize = 5;
  for (let i = 0; i < sourceIds.length; i += batchSize) {
    if (signal?.aborted) break;
    await Promise.all(
      sourceIds.slice(i, i + batchSize).map(async (sourceId) => {
        const installedVersion = packageVersions.get(sourceId);
        if (!installedVersion) return;

        const frameworks = await fetchDependencyFrameworksAsync(
          sourceId,
          installedVersion,
          sources,
          detailsCache,
          signal
        );
        if (!frameworks) return;

        const dependencies = selectDependencyGroup(frameworks, [...tfms]);
        if (!dependencies) return;

        for (const dependency of dependencies) {
          const candidateId = dependency.package.toLowerCase();
          if (!candidateIds.has(candidateId)) continue;

          const constraints = result.get(candidateId) ?? [];
          const duplicate = constraints.some(
            (constraint) =>
              constraint.PackageId.toLowerCase() === sourceId && constraint.Range === dependency.versionRange
          );
          if (!duplicate) {
            constraints.push({
              // Prefer the casing from the project file over the lowercased
              // assets key so the warning names the package the user sees.
              PackageId: group.direct.get(sourceId)?.id ?? sourceId,
              InstalledVersion: installedVersion,
              Range: dependency.versionRange,
            });
          }
          result.set(candidateId, constraints);
        }
      })
    );
  }

  return result;
}

function formatConstraintReason(constraints: PackageConstraint[]): string {
  if (constraints.length === 0) return "no available version satisfies the installed dependency ranges";
  return constraints
    .map((constraint) => `${constraint.PackageId} ${constraint.InstalledVersion} requires ${constraint.Range}`)
    .join("; ");
}
