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
};

export type GetOperationProgressRequest = {
  OperationId: string;
};

export type GetOperationProgressResponse = {
  Stage: string;
  Percent: number;
  Active: boolean;
};

export type BatchUpdateRequest = {
  Updates: Array<{
    PackageId: string;
    Version: string;
    ProjectPaths: string[];
  }>;
  SkipRestore?: boolean;
};

export type RestoreProjectsRequest = {
  ProjectPaths: string[];
};

export type ConsolidateRequest = {
  PackageId: string;
  TargetVersion: string;
  ProjectPaths: string[];
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
};

export type GetConfigurationResponse = {
  Configuration: Configuration;
};

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
  updateProjectAsync(req: UpdateProjectRequest): Promise<Result<UpdateProjectResponse>>;
  getConfigurationAsync(): Promise<Result<GetConfigurationResponse>>;
  updateConfigurationAsync(req: UpdateConfigurationRequest): Promise<Result<void>>;
  openUrlAsync(req: OpenUrlRequest): Promise<Result<void>>;
  updateStatusBarAsync(req: UpdateStatusBarRequest): Promise<Result<void>>;
  getOutdatedPackagesAsync(req: GetOutdatedPackagesRequest, signal?: AbortSignal): Promise<Result<GetOutdatedPackagesResponse>>;
  batchUpdatePackagesAsync(req: BatchUpdateRequest): Promise<Result<BatchUpdateResponse>>;
  restoreProjectsAsync(req: RestoreProjectsRequest): Promise<Result<void>>;
  getInconsistentPackagesAsync(req: GetInconsistentPackagesRequest, signal?: AbortSignal): Promise<Result<GetInconsistentPackagesResponse>>;
  consolidatePackagesAsync(req: ConsolidateRequest): Promise<Result<void>>;
  getVulnerablePackagesAsync(req: GetVulnerablePackagesRequest, signal?: AbortSignal): Promise<Result<GetVulnerablePackagesResponse>>;
  showConfirmationAsync(req: ShowConfirmationRequest): Promise<Result<ShowConfirmationResponse>>;
  getOperationProgressAsync(req: GetOperationProgressRequest): Promise<Result<GetOperationProgressResponse>>;
}

// ============================================================
// RPC Timeout
// ============================================================

export const RPC_TIMEOUT_MS = 120_000;
