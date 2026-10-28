import type { Result } from "./result";

// ============================================================
// Domain Types (re-exported from common/types.ts)
// ============================================================

// These are defined globally in common/types.ts and referenced here
// for type-safety in the HostAPI interface. The actual domain types
// (Package, Project, Configuration, etc.) remain in common/types.ts.

// ============================================================
// Reusable Request Building Blocks
// ============================================================

export type SourceContext = {
  Url: string;
  SourceName?: string;
  PasswordScriptPath?: string;
};

export type PaginationParams = {
  Skip: number;
  Take: number;
};

export type CacheControl = {
  ForceReload?: boolean;
};

// ============================================================
// Request Types
// ============================================================

export type GetProjectsRequest = CacheControl;

export type GetPackagesRequest = SourceContext &
  PaginationParams &
  CacheControl & {
    Filter: string;
    Prerelease: boolean;
    Sort?: "relevance" | "downloads" | "recent" | "name-asc";
  };

export type GetPackageRequest = SourceContext &
  CacheControl & {
    Id: string;
    Prerelease: boolean;
  };

export type GetPackageDetailsRequest = SourceContext & {
  PackageVersionUrl: string;
};

export type GetOutdatedPackagesRequest = CacheControl & {
  Prerelease: boolean;
  ProjectPaths?: string[];
  SourceUrl?: string;
  /** Return the persisted last scan without contacting the feeds. */
  PreferCache?: boolean;
  /**
   * Optional correlation id. When supplied, the host records live progress for this
   * scan which the webview can poll with `getOutdatedScanProgressAsync`.
   */
  ScanId?: string;
};

export type GetInconsistentPackagesRequest = CacheControl & {
  ProjectPaths?: string[];
};

export type GetVulnerablePackagesRequest = CacheControl & {
  ProjectPaths?: string[];
};

export type UpdateProjectRequest = {
  ProjectPath: string;
  PackageId: string;
  Version?: string;
  Type: "INSTALL" | "UNINSTALL" | "UPDATE";
  SourceUrl?: string;
  OperationId?: string;
  CpmCondition?: string;
  CpmTfm?: string;
};

export type GetOperationProgressRequest = {
  OperationId: string;
};

export type GetOperationProgressResponse = {
  Stage: string;
  Percent: number;
  Active: boolean;
};

export type GetOutdatedScanProgressRequest = {
  ScanId: string;
};

export type GetOutdatedScanProgressResponse = {
  /** Human-readable stage, e.g. "Checking latest versions (12/60)…". */
  Stage: string;
  /** Overall completion, 0-100. */
  Percent: number;
  /** Units finished in the current stage (packages, projects, conditions). */
  Completed: number;
  /** Units in the current stage, or 0 when the stage has no countable units. */
  Total: number;
  /** False once the scan has finished or the id is unknown. */
  Active: boolean;
};

export type BatchUpdateRequest = {
  Updates: Array<{
    PackageId: string;
    Version: string;
    ProjectPaths: string[];
    CpmCondition?: string;  // raw XML Condition for framework-scoped CPM updates
    CpmTfm?: string;        // resolved TFM for display/telemetry
    Scope?: "group" | "unconditional" | "all" | "first";
  }>;
  SkipRestore?: boolean;
  /** Snapshot affected files, restore once, and roll back on failure. */
  Transactional?: boolean;
};

/**
 * One selected package whose requested version cannot be applied together with
 * the rest of the batch. Produced by the preflight check before anything is
 * written; `dotnet restore` remains the final authority.
 */
export type BatchUpdateConflict = {
  /** The selected package to drop from this batch. */
  PackageId: string;
  RequestedVersion: string;
  /** The package that declares the incompatible requirement. */
  BlockedByPackageId: string;
  /** The version of the blocking package (installed, or selected when it is in the batch). */
  BlockedByVersion: string;
  /** The NuGet range that rejects the effective version, e.g. `= 11.0.0-rc.2`. */
  RequiredRange: string;
  /** Version the dependency graph would resolve for the blocked package. */
  EffectiveVersion: string;
  ProjectPath: string;
  Reason: string;
};

export type CheckBatchUpdateResponse = {
  Conflicts: BatchUpdateConflict[];
};

export type RestoreProjectsRequest = {
  ProjectPaths: string[];
};

export type UpdateBadgeRequest = {
  Count: number;
  /** Updates held back because installed dependencies pin an incompatible version. */
  BlockedCount?: number;
};

export type ConsolidateRequest = {
  PackageId: string;
  TargetVersion: string;
  ProjectPaths: string[];
  CpmCondition?: string;
  Scope?: "group" | "unconditional" | "all" | "first";
};

export type CleanupReport = {
  PropsFiles: Array<{ Path: string; Defined: string[]; Unused: string[] }>;
  Used: string[];
  Missing: string[];
  Unused: string[];
};

export type CleanupUnusedRequest = {
  ProjectPaths?: string[];
};

export type CleanupUnusedResponse = {
  Report: CleanupReport;
  Removed: string[];
  Backups: string[];
  Errors: string[];
};

export type UpdateConfigurationRequest = {
  Configuration: Configuration;
};

export type OpenUrlRequest = {
  Url: string;
};

export type UpdateStatusBarRequest = {
  Percentage: number | null;
  Message?: string;
};

export type ShowConfirmationRequest = {
  Message: string;
  Detail?: string;
};

export type ShowConfirmationResponse = {
  Confirmed: boolean;
};

// ============================================================
// Response Types (only data, errors handled by Result<T>)
// ============================================================

export type GetProjectsResponse = {
  Projects: Project[];
};

export type GetPackagesResponse = {
  Packages: Package[];
};

export type GetPackageResponse = {
  Package: Package;
  SourceUrl: string;
};

export type GetPackageDetailsResponse = {
  Package: PackageDetails;
};

export type GetOutdatedPackagesResponse = {
  Packages: OutdatedPackage[];
  /** Updates withheld because a dependency pins an incompatible version. */
  BlockedPackages?: Array<{
    Id: string;
    InstalledVersion: string;
    /** The version that was available but rejected by the dependency ranges. */
    BlockedVersion: string;
    Reason: string;
    BlockedBy: Array<{ PackageId: string; InstalledVersion: string; Range: string }>;
  }>;
  /** True when the payload came from the persisted scan cache. */
  FromCache?: boolean;
  /** ISO timestamp of the scan that produced the payload. */
  ScannedAt?: string;
};

export type GetInconsistentPackagesResponse = {
  Packages: InconsistentPackage[];
};

export type GetVulnerablePackagesResponse = {
  Packages: VulnerablePackage[];
};

export type UpdateProjectResponse = {
  Project: Project;
  IsCpmEnabled: boolean;
};

export type BatchUpdateResponse = {
  Results: Array<{
    PackageId: string;
    Success: boolean;
    Error?: string;
  }>;
  /** True when the host restored the pre-update file contents after a failure. */
  RolledBack?: boolean;
  /** The restore failure that triggered a rollback. */
  RestoreError?: string;
  /** A failure while restoring the snapshots or re-restoring the old versions. */
  RollbackError?: string;
  /**
   * Batch rows that the restore failure points at, so the user can retry
   * without them instead of re-selecting by hand.
   */
  ConflictingPackages?: string[];
  /** True when the user cancelled; the transaction was rolled back. */
  Cancelled?: boolean;
};

export type GetConfigurationResponse = {
  Configuration: Configuration;
};

// ============================================================
// Long-running operation jobs
// ============================================================

/**
 * Long mutations (batch update, single package update, consolidate, cleanup)
 * run as host-side jobs so no client deadline governs how long a
 * snapshot/write/restore sequence may take. The webview starts a job, polls
 * `getJobAsync` for stage + percent, and reads the final response once the job
 * is no longer `running`.
 */
export type JobKind = "batchUpdate" | "projectUpdate" | "consolidate" | "cleanup";

export type JobState = "running" | "completed" | "failed" | "cancelled";

export type JobStatus<TKind extends JobKind, TResponse> = {
  Kind: TKind;
  State: JobState;
  /** Human-readable stage, e.g. "Restoring updated projects…". */
  Stage: string;
  /** Overall completion, 0-100. */
  Percent: number;
  /** The operation outcome; present once State is not "running". */
  Response?: TResponse;
  /** A failure of the job itself (unexpected throw), not of a package. */
  Error?: string;
};

export type StartJobResponse = {
  JobId: string;
};

export type JobRequest = {
  JobId: string;
};

export type GetJobResponse =
  | JobStatus<"batchUpdate", BatchUpdateResponse>
  | JobStatus<"projectUpdate", UpdateProjectResponse>
  | JobStatus<"consolidate", void>
  | JobStatus<"cleanup", CleanupUnusedResponse>;

// ============================================================
// Wire Protocol (internal, over postMessage)
// ============================================================

export type RpcRequest = {
  type: "rpc-request";
  id: number;
  method: string;
  params: unknown;
};

export type RpcResponse = {
  type: "rpc-response";
  id: number;
  result: Result<unknown>;
};

export type RpcCancel = {
  type: "rpc-cancel";
  id: number;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcCancel;

// ============================================================
// Host API Contract
// ============================================================

export interface HostAPI {
  getProjectsAsync(req: GetProjectsRequest, signal?: AbortSignal): Promise<Result<GetProjectsResponse>>;
  getPackagesAsync(req: GetPackagesRequest, signal?: AbortSignal): Promise<Result<GetPackagesResponse>>;
  getPackageAsync(req: GetPackageRequest, signal?: AbortSignal): Promise<Result<GetPackageResponse>>;
  getPackageDetailsAsync(req: GetPackageDetailsRequest, signal?: AbortSignal): Promise<Result<GetPackageDetailsResponse>>;
  updateProjectAsync(req: UpdateProjectRequest, signal?: AbortSignal): Promise<Result<UpdateProjectResponse>>;
  getConfigurationAsync(): Promise<Result<GetConfigurationResponse>>;
  updateConfigurationAsync(req: UpdateConfigurationRequest): Promise<Result<void>>;
  openUrlAsync(req: OpenUrlRequest): Promise<Result<void>>;
  updateStatusBarAsync(req: UpdateStatusBarRequest): Promise<Result<void>>;
  getOutdatedPackagesAsync(req: GetOutdatedPackagesRequest, signal?: AbortSignal): Promise<Result<GetOutdatedPackagesResponse>>;
  batchUpdatePackagesAsync(req: BatchUpdateRequest, signal?: AbortSignal): Promise<Result<BatchUpdateResponse>>;
  checkBatchUpdateAsync(req: BatchUpdateRequest, signal?: AbortSignal): Promise<Result<CheckBatchUpdateResponse>>;
  startBatchUpdateAsync(req: BatchUpdateRequest): Promise<Result<StartJobResponse>>;
  startProjectUpdateAsync(req: UpdateProjectRequest): Promise<Result<StartJobResponse>>;
  startConsolidateAsync(req: ConsolidateRequest): Promise<Result<StartJobResponse>>;
  startCleanupAsync(req: CleanupUnusedRequest): Promise<Result<StartJobResponse>>;
  getJobAsync(req: JobRequest): Promise<Result<GetJobResponse>>;
  cancelJobAsync(req: JobRequest): Promise<Result<void>>;
  restoreProjectsAsync(req: RestoreProjectsRequest, signal?: AbortSignal): Promise<Result<void>>;
  updateBadgeAsync(req: UpdateBadgeRequest): Promise<Result<void>>;
  getInconsistentPackagesAsync(req: GetInconsistentPackagesRequest, signal?: AbortSignal): Promise<Result<GetInconsistentPackagesResponse>>;
  consolidatePackagesAsync(req: ConsolidateRequest, signal?: AbortSignal): Promise<Result<void>>;
  getCleanupReportAsync(req: CleanupUnusedRequest, signal?: AbortSignal): Promise<Result<CleanupReport>>;
  cleanupUnusedPackagesAsync(req: CleanupUnusedRequest, signal?: AbortSignal): Promise<Result<CleanupUnusedResponse>>;
  getVulnerablePackagesAsync(req: GetVulnerablePackagesRequest, signal?: AbortSignal): Promise<Result<GetVulnerablePackagesResponse>>;
  showConfirmationAsync(req: ShowConfirmationRequest): Promise<Result<ShowConfirmationResponse>>;
  getOperationProgressAsync(req: GetOperationProgressRequest): Promise<Result<GetOperationProgressResponse>>;
  getOutdatedScanProgressAsync(req: GetOutdatedScanProgressRequest): Promise<Result<GetOutdatedScanProgressResponse>>;
}

// ============================================================
// RPC Timeout
// ============================================================

export const RPC_TIMEOUT_MS = 120_000;
