import axios, { AxiosError, AxiosInstance, AxiosProxyConfig, AxiosRequestConfig, AxiosResponse } from "axios";
import * as vscode from "vscode";
import { Logger } from "../../common/logger";
import { compareVersions } from "../utilities/version";
import LocalNuGetFeed from "./local-feed";
import { HttpCache } from "./http-cache";

type RawPackageSearchItem = {
  "@id": string;
  id: string;
  authors: string[];
  description: string;
  iconUrl: string;
  registration: string;
  licenseUrl: string;
  projectUrl: string;
  totalDownloads: number;
  verified: boolean;
  version: string;
  versions: Array<{ version: string; "@id": string }>;
  tags: string[];
};

type RawCatalogItem = {
  "@id": string;
  catalogEntry: RawCatalogEntry | string;
};

type RawCatalogEntry = {
  "@id"?: string;
  id: string;
  version: string;
  authors?: string | string[];
  description?: string;
  iconUrl?: string;
  registration?: string;
  licenseUrl?: string;
  projectUrl?: string;
  totalDownloads?: number;
  verified?: boolean;
  tags?: string[];
  dependencyGroups?: RawDependencyGroup[];
};

type RawDependencyGroup = {
  targetFramework: string;
  dependencies?: Array<{ id: string; range: string }>;
};

type RawRegistrationPage = {
  "@id"?: string;
  items?: RawCatalogItem[];
};

type GetPackagesResponse = {
  data: Array<Package>;
};

type GetPackageResponse = {
  isError: boolean;
  errorMessage: string | undefined;
  data: Package | undefined;
};

type GetPackageDetailsResponse = {
  data: PackageDetails;
};

export default class NuGetApi {
  private _searchUrl: string = "";
  private _packageInfoUrl: string = "";
  private _vulnerabilityUrl: string = "";
  private readonly http: AxiosInstance;
  private _packageCache: Map<string, { data: Package, timestamp: number }> = new Map();
  private _packageDetailsCache: Map<string, PackageDetails> = new Map();
  private _vulnerabilityCache: { data: Map<string, VulnerabilityEntry[]>, timestamp: number } | null = null;
  private readonly _cacheTtl: number = 5 * 60 * 1000; // 5 minutes
  private readonly _vulnCacheTtl: number = 60 * 60 * 1000; // 1 hour

  private _sourceHost: string = "";
  private readonly _trustedHosts = new Set<string>();
  private readonly _localFeed: LocalNuGetFeed | null;
  private readonly _httpCache: HttpCache;

  constructor(
    private readonly _url: string,
    private readonly _username?: string,
    private readonly _password?: string,
    httpCacheDirectory?: string
  ) {
    this._httpCache = new HttpCache(httpCacheDirectory ?? null);
    this._localFeed = LocalNuGetFeed.IsLocalSource(this._url)
      ? new LocalNuGetFeed(this._url)
      : null;
    const proxy = this.getProxy();
    this.http = axios.create({
      ...(proxy !== undefined && { proxy }),
    });

    try {
      this._sourceHost = new URL(this._url).host.toLowerCase();
      this._trustedHosts.add(this._sourceHost);
    } catch {
      this._sourceHost = "";
    }

    // Add Basic Auth only for the configured source origin and the service
    // endpoints that origin declares. Feed items can contain absolute URLs;
    // credentials must not follow arbitrary hosts.
    if (this._password) {
      const token = btoa(`${this._username ?? ""}:${this._password}`);
      this.http.interceptors.request.use((config) => {
        if (!this.isTrustedSourceUrl(config.url ?? "")) return config;
        config.headers["Authorization"] = `Basic ${token}`;
        return config;
      });
    }
  }

  private isTrustedSourceUrl(url: string): boolean {
    if (this._trustedHosts.size === 0) return false;
    try {
      return this._trustedHosts.has(new URL(url, this._url).host.toLowerCase());
    } catch {
      return false;
    }
  }

  async GetPackagesAsync(
    filter: string,
    prerelease: boolean,
    skip: number,
    take: number,
    signal?: AbortSignal
  ): Promise<GetPackagesResponse> {
    Logger.debug(`NuGetApi.GetPackagesAsync: Fetching packages (filter: '${filter}', prerelease: ${prerelease}, skip: ${skip}, take: ${take})`);
    if (this._localFeed) {
      return {
        data: await this._localFeed.GetPackagesAsync(filter, prerelease, skip, take, signal),
      };
    }
    await this.EnsureSearchUrlAsync();
    const result = await this.ExecuteGetAsync(this._searchUrl, {
      params: {
        q: filter,
        take: take,
        skip: skip,
        prerelease: prerelease,
        semVerLevel: "2.0.0",
      },
      ...(signal && { signal }),
    });
    const mappedData: Array<Package> = (result.data.data as RawPackageSearchItem[]).map((item) => ({
      Id: item["@id"] || "",
      Name: item.id || "",
      Authors: item.authors || [],
      Description: item.description || "",
      IconUrl: item.iconUrl || "",
      Registration: item.registration || "",
      LicenseUrl: item.licenseUrl || "",
      ProjectUrl: item.projectUrl || "",
      TotalDownloads: item.totalDownloads || 0,
      Verified: item.verified || false,
      Version: item.version || "",
      InstalledVersion: "",
      Versions:
        item.versions.map((v) => ({
          Version: v.version,
          Id: v["@id"],
        })) || [],
      Tags: item.tags || [],
    }));

    return {
      data: mappedData,
    };
  }

  async GetPackageAsync(id: string, prerelease: boolean = true, signal?: AbortSignal): Promise<GetPackageResponse> {
    if (this._localFeed) {
      const pkg = await this._localFeed.GetPackageAsync(id, prerelease, signal);
      return pkg
        ? { data: pkg, isError: false, errorMessage: undefined }
        : { data: undefined, isError: true, errorMessage: "Package couldn't be found" };
    }
    const cacheKey = `${id.toLowerCase()}::${prerelease}`;
    const cached = this._packageCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < this._cacheTtl)) {
      Logger.debug(`NuGetApi.GetPackageAsync: Returning cached package info for ${id} (prerelease: ${prerelease})`);
      return { data: cached.data, isError: false, errorMessage: undefined };
    }

    Logger.debug(`NuGetApi.GetPackageAsync: Fetching package info for ${id} (prerelease: ${prerelease})`);
    await this.EnsureSearchUrlAsync();
    const url = new URL([id.toLowerCase(), "index.json"].join("/"), this._packageInfoUrl).href;
    const items = await this.loadRegistrationItemsAsync(url, signal);
    if (items.length <= 0) throw new Error("Package info couldn't be found for url:" + url);

    const itemsToUse = this.selectRegistrationItems(items, prerelease, id);
    this.cacheRegistrationDetailGroups(itemsToUse);

    const item = this.pickLatestItem(itemsToUse);
    const packageObject = this.buildPackageFromItem(item, itemsToUse);
    this._packageCache.set(cacheKey, { data: packageObject, timestamp: Date.now() });

    return { data: packageObject, isError: false, errorMessage: undefined };
  }

  private async loadRegistrationItemsAsync(url: string, signal?: AbortSignal): Promise<RawCatalogItem[]> {
    const items: RawCatalogItem[] = [];
    try {
      Logger.debug(`NuGetApi.GetPackageAsync: GET ${url}`);
      const result = await this.ExecuteGetAsync(url, signal ? { signal } : undefined);

      for (let i = 0; i < result.data.count; i++) {
        if (signal?.aborted) break;
        const page: RawRegistrationPage = result.data.items[i];
        if (page.items) {
          items.push(...page.items);
          continue;
        }
        try {
          const pageData = await this.ExecuteGetAsync(page["@id"] as string, signal ? { signal } : undefined);
          items.push(...(pageData.data.items as RawCatalogItem[]));
        } catch (err) {
          Logger.error("NuGetApi.GetPackageAsync: Error while loading page data:", err);
        }
      }
    } catch (err) {
      Logger.error(`NuGetApi.GetPackageAsync: ERROR url: ${url}`, err);
    }
    return items;
  }

  private selectRegistrationItems(
    items: RawCatalogItem[],
    prerelease: boolean,
    id: string
  ): RawCatalogItem[] {
    // Prerelease versions contain a hyphen (e.g., 1.0.0-beta).
    if (prerelease) return items;

    const filtered = items.filter((item) => {
      const entry = typeof item.catalogEntry === 'object' ? item.catalogEntry as RawCatalogEntry : null;
      return !entry?.version?.includes('-');
    });
    if (filtered.length === 0) {
      Logger.warn(`NuGetApi.GetPackageAsync: No stable versions found for ${id}, falling back to all versions including prerelease`);
    }
    return filtered.length > 0 ? filtered : items;
  }

  private cacheRegistrationDetailGroups(items: RawCatalogItem[]): void {
    // Registration entries often embed dependencyGroups. Keep them keyed by the
    // version leaf URL so a later GetPackageDetailsAsync call for the same
    // version is served locally instead of issuing another request.
    for (const versionItem of items) {
      const entry = typeof versionItem.catalogEntry === "object"
        ? versionItem.catalogEntry as RawCatalogEntry
        : null;
      if (entry?.dependencyGroups && versionItem["@id"]) {
        this._packageDetailsCache.set(versionItem["@id"], {
          dependencies: { frameworks: this.mapDependencyGroups(entry.dependencyGroups) },
        });
      }
    }
  }

  private pickLatestItem(items: RawCatalogItem[]): RawCatalogItem {
    const sorted = [...items].sort((a, b) => {
      const versionA = typeof a.catalogEntry === "object" ? a.catalogEntry.version ?? "" : "";
      const versionB = typeof b.catalogEntry === "object" ? b.catalogEntry.version ?? "" : "";
      return compareVersions(versionA, versionB);
    });
    return sorted[sorted.length - 1]!;
  }

  private buildPackageFromItem(item: RawCatalogItem, items: RawCatalogItem[]): Package {
    const catalogEntry = item.catalogEntry as RawCatalogEntry;
    return {
      Id: item["@id"] || "",
      Name: catalogEntry?.id || "",
      Authors: (typeof catalogEntry?.authors === "string" ? [catalogEntry.authors] : catalogEntry?.authors) || [],
      Description: catalogEntry?.description || "",
      IconUrl: catalogEntry?.iconUrl || "",
      Registration: catalogEntry?.registration || "",
      LicenseUrl: catalogEntry?.licenseUrl || "",
      ProjectUrl: catalogEntry?.projectUrl || "",
      TotalDownloads: catalogEntry?.totalDownloads || 0,
      Verified: catalogEntry?.verified || false,
      Version: catalogEntry?.version || "",
      InstalledVersion: "",
      Versions: items.map((v) => ({
        Version: (v.catalogEntry as RawCatalogEntry).version,
        Id: v["@id"],
      })),
      Tags: catalogEntry?.tags || [],
    };
  }

  public ClearPackageCache(packageId?: string) {
    this._localFeed?.ClearCache();
    if (!packageId) {
      this._packageDetailsCache.clear();
    }
    if (packageId) {
      // Cache keys are "${id}::${prerelease}" — delete all variants for this id.
      const prefix = packageId.toLowerCase() + "::";
      for (const key of this._packageCache.keys()) {
        if (key.startsWith(prefix)) {
          this._packageCache.delete(key);
        }
      }
    } else {
      this._packageCache.clear();
    }
  }

  public ClearVulnerabilityCache() {
    this._vulnerabilityCache = null;
  }

  /** Removes the persisted HTTP cache (used by ForceReload). */
  public ClearHttpCache(): void {
    this._httpCache.Clear();
  }

  async GetPackageDetailsAsync(packageVersionUrl: string, signal?: AbortSignal): Promise<GetPackageDetailsResponse> {
    try {
      if (this._localFeed) {
        return { data: await this._localFeed.GetPackageDetailsAsync(packageVersionUrl) };
      }
      const cachedDetails = this._packageDetailsCache.get(packageVersionUrl);
      if (cachedDetails) {
        Logger.debug(`NuGetApi.GetPackageDetailsAsync: Returning cached dependency groups for ${packageVersionUrl}`);
        return { data: cachedDetails };
      }
      await this.EnsureSearchUrlAsync();
      if (!this.isTrustedSourceUrl(packageVersionUrl)) {
        throw new Error("Refusing to fetch package details from an untrusted source host");
      }
      Logger.debug(`NuGetApi.GetPackageDetailsAsync: Fetching package version from ${packageVersionUrl}`);
      const packageVersion = await this.ExecuteGetAsync(packageVersionUrl, ...(signal ? [{ signal }] : []));
      
      if (!packageVersion.data?.catalogEntry) {
        Logger.debug(`NuGetApi.GetPackageDetailsAsync: No catalogEntry found in package version response`);
        return {
          data: {
            dependencies: {
              frameworks: {},
            },
          },
        };
      }
      
      const catalogEntry = packageVersion.data.catalogEntry;
      let catalogData: RawCatalogEntry;
      
      // Check if catalogEntry is an embedded object with dependencyGroups (some feeds embed the data)
      // or if it's a URL/object with @id that needs to be fetched
      if (typeof catalogEntry === 'object' && catalogEntry.dependencyGroups !== undefined) {
        // catalogEntry is already an embedded object with dependency data
        Logger.debug(`NuGetApi.GetPackageDetailsAsync: Using embedded catalogEntry data`);
        catalogData = catalogEntry;
      } else {
        // catalogEntry is a URL string or an object with @id - need to fetch it
        const catalogUrl = typeof catalogEntry === 'string' ? catalogEntry : catalogEntry['@id'];
        if (!catalogUrl) {
          Logger.debug(`NuGetApi.GetPackageDetailsAsync: No valid catalog URL found`);
          return {
            data: {
              dependencies: {
                frameworks: {},
              },
            },
          };
        }
        Logger.debug(`NuGetApi.GetPackageDetailsAsync: Fetching catalog from ${catalogUrl}`);
        const result = await this.ExecuteGetAsync(catalogUrl, ...(signal ? [{ signal }] : []));
        catalogData = result.data;
      }

      const packageDetails: PackageDetails = {
        dependencies: {
          frameworks: this.mapDependencyGroups(catalogData?.dependencyGroups ?? []),
        },
      };

      Logger.debug(`NuGetApi.GetPackageDetailsAsync: Returning ${Object.keys(packageDetails.dependencies.frameworks).length} frameworks with dependencies`);
      this._packageDetailsCache.set(packageVersionUrl, packageDetails);
      return { data: packageDetails };
    }
    catch (err) {
      Logger.error(`NuGetApi.GetPackageDetailsAsync: ERROR fetching package details: ${packageVersionUrl}`, err);
      throw err;
    }
  }

  async GetVulnerabilitiesAsync(signal?: AbortSignal): Promise<Map<string, VulnerabilityEntry[]>> {
    if (this._localFeed) return new Map();
    // Return cached data if fresh
    if (this._vulnerabilityCache && (Date.now() - this._vulnerabilityCache.timestamp < this._vulnCacheTtl)) {
      Logger.debug("NuGetApi.GetVulnerabilitiesAsync: Returning cached vulnerability data");
      return this._vulnerabilityCache.data;
    }

    Logger.debug("NuGetApi.GetVulnerabilitiesAsync: Fetching vulnerability data");
    await this.EnsureSearchUrlAsync();

    if (!this._vulnerabilityUrl) {
      Logger.debug("NuGetApi.GetVulnerabilitiesAsync: No vulnerability endpoint available");
      return new Map();
    }

    const vulnerabilities = new Map<string, VulnerabilityEntry[]>();
    let complete = true;

    try {
      const indexResponse = await this.ExecuteGetAsync(this._vulnerabilityUrl, ...(signal ? [{ signal }] : []));
      const pages: Array<{ "@name": string; "@id": string; "@updated": string }> = indexResponse.data;

      for (const page of pages) {
        if (signal?.aborted) {
          complete = false;
          break;
        }
        const pageResponse = await this.ExecuteGetAsync(page["@id"], ...(signal ? [{ signal }] : []));
        const data: Record<string, VulnerabilityEntry[]> = pageResponse.data;

        for (const [packageId, entries] of Object.entries(data)) {
          const existing = vulnerabilities.get(packageId) ?? [];
          existing.push(...entries);
          vulnerabilities.set(packageId, existing);
        }
      }

      if (complete) {
        Logger.info(`NuGetApi.GetVulnerabilitiesAsync: Loaded vulnerabilities for ${vulnerabilities.size} packages`);
      }
    } catch (err) {
      complete = false;
      Logger.error("NuGetApi.GetVulnerabilitiesAsync: Failed to fetch vulnerabilities", err);
    }

    // Never replace a good cache with a partial result; a failed page would
    // otherwise hide CVEs for the whole TTL.
    if (complete) {
      this._vulnerabilityCache = { data: vulnerabilities, timestamp: Date.now() };
    }
    return vulnerabilities;
  }

  private async EnsureSearchUrlAsync() {
    if (this._searchUrl !== "" && this._packageInfoUrl !== "") return;

    Logger.debug(`NuGetApi.EnsureSearchUrl: resolving service URLs from ${this._url}`);
    const response = await this.ExecuteGetAsync(this._url);

    this._searchUrl = await this.GetUrlFromNugetDefinitionAsync(response, "SearchQueryService");
    if (this._searchUrl == "") throw new Error("SearchQueryService couldn't be found");
    if (!this._searchUrl.endsWith("/")) this._searchUrl += "/";
    this._packageInfoUrl = await this.GetRegistrationsBaseUrl(response);
    if (this._packageInfoUrl == "") throw new Error("RegistrationsBaseUrl couldn't be found");
    if (!this._packageInfoUrl.endsWith("/")) this._packageInfoUrl += "/";

    // Vulnerability endpoint is optional (not all feeds support it)
    if (!this._vulnerabilityUrl) {
      this._vulnerabilityUrl = await this.GetUrlFromNugetDefinitionAsync(response, "VulnerabilityInfo");
    }

    for (const serviceUrl of [this._searchUrl, this._packageInfoUrl, this._vulnerabilityUrl]) {
      if (!serviceUrl) continue;
      try {
        this._trustedHosts.add(new URL(serviceUrl).host.toLowerCase());
      } catch {
        // Ignore malformed service URLs.
      }
    }

    Logger.debug(`NuGetApi.EnsureSearchUrl: SearchUrl=${this._searchUrl}, PackageInfoUrl=${this._packageInfoUrl}, VulnerabilityUrl=${this._vulnerabilityUrl}`);
  }

  private GetRegistrationsBaseUrl(response: AxiosResponse): string {
    const resources: Array<{ "@type": string; "@id": string }> = response.data.resources ?? [];
    // Pick the highest-versioned RegistrationsBaseUrl from the service index
    const matches = resources
      .filter((r) => r["@type"].startsWith("RegistrationsBaseUrl"))
      .sort((a, b) => b["@type"].localeCompare(a["@type"]));

    if (matches.length > 0) {
      Logger.debug(`NuGetApi.GetRegistrationsBaseUrl: Resolved via ${matches[0]?.["@type"]} -> ${matches[0]?.["@id"]}`);
      return matches[0]?.["@id"] ?? "";
    }

    Logger.error("NuGetApi.GetRegistrationsBaseUrl: No RegistrationsBaseUrl found in service index");
    return "";
  }

  private GetUrlFromNugetDefinitionAsync(response: AxiosResponse, type: string): Promise<string> {
    const resource = (response.data.resources as Array<{ "@type": string; "@id": string }>).find((x) => x["@type"].includes(type));
    return Promise.resolve(resource != null ? resource["@id"] : "");
  }

  private mapDependencyGroups(groups: RawDependencyGroup[]): Record<string, PackageDependency[]> {
    const frameworks: Record<string, PackageDependency[]> = {};
    for (const group of groups) {
      const dependencies: PackageDependency[] = [];
      for (const dependency of group.dependencies ?? []) {
        dependencies.push({ package: dependency.id, versionRange: dependency.range });
      }
      if (dependencies.length > 0) {
        frameworks[group.targetFramework] = dependencies;
      }
    }
    return frameworks;
  }

  private buildHttpCacheKey(url: string, config?: AxiosRequestConfig): string {
    const params = config?.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== "object") return url;
    const query = Object.keys(params)
      .sort((a, b) => a.localeCompare(b))
      .filter((key) => params[key] !== undefined)
      .map((key) => `${key}=${String(params[key])}`)
      .join("&");
    return query ? `${url}?${query}` : url;
  }

  private async ExecuteGetAsync(
    url: string,
    config?: AxiosRequestConfig | undefined
  ): Promise<AxiosResponse> {
    const cacheKey = this.buildHttpCacheKey(url, config);
    const cached = await this._httpCache.GetAsync<unknown>(cacheKey);
    if (cached !== null) {
      Logger.debug(`NuGetApi.ExecuteGet: Serving ${url} from the HTTP cache`);
      return { data: cached } as AxiosResponse;
    }

    Logger.debug(`NuGetApi.ExecuteGet: Requesting ${url}`);
    const response = await this.http.get(url, config);
    if (response instanceof AxiosError) {
      Logger.error("NuGetApi.ExecuteGet: Axios Error Data:", response.response?.data);
      throw new Error(`${response.message} on request to${url}`);
    }

    if (response?.data !== undefined) {
      await this._httpCache.SetAsync(cacheKey, response.data);
    }
    return response;
  }

  private getProxy(): AxiosProxyConfig | undefined {
    let proxy: string | undefined = vscode.workspace.getConfiguration().get("http.proxy");
    if (proxy === "" || proxy == undefined) {
      proxy =
        process.env["HTTPS_PROXY"] ??
        process.env["https_proxy"] ??
        process.env["HTTP_PROXY"] ??
        process.env["http_proxy"];
    }

    if (proxy && proxy !== "") {
      const proxy_url = new URL(proxy);

      Logger.info(`NuGetApi.getProxy: Found proxy: ${proxy}`);

      return {
        host: proxy_url.hostname,
        port: Number(proxy_url.port),
      };
    } else {
      return undefined;
    }
  }
}
