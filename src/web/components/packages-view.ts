import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import Split from "split.js";
import hash from "object-hash";
import lodash from "lodash";
import { hostApi, configuration } from "@/web/registrations";
import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { PackageViewModel, ProjectViewModel } from "../types";
import type { FilterEvent } from "./search-bar";
import type { SearchBar } from "./search-bar";
import type { UpdatesView } from "./updates-view";
import type { ConsolidateView } from "./consolidate-view";
import type { VulnerabilitiesView } from "./vulnerabilities-view";
import type { DropdownOption } from "./dropdown";
import "./dropdown";

type TabId = "browse" | "installed" | "updates" | "consolidate" | "vulnerabilities";

const PACKAGE_FETCH_TAKE = 50;
const PACKAGE_CONTAINER_SCROLL_MARGIN = 196;
const NUGET_ORG_PREFIX = "https://api.nuget.org";

@customElement("packages-view")
export class PackagesView extends LitElement {
  static override styles = [
    codicon,
    scrollableBase,
    sharedStyles,
    css`
      .container {
        display: flex;
        height: 100%;

        .error {
          display: flex;
          gap: 4px;
          justify-content: center;
          flex: 1;
          margin-top: 32px;
          color: var(--vscode-errorForeground);
        }

        &:focus-visible {
          outline: unset;
        }

        .col {
          overflow: hidden;
        }

        .gutter {
          display: flex;
          margin: 0 6px;
          justify-content: center;
          transition: background-color 0.1s ease-out;

          &:hover {
            cursor: col-resize;
            background-color: var(--vscode-sash-hoverBorder);
          }
        }

        .gutter-nested {
          width: 1px;
          background-color: var(--vscode-panelSection-border);
        }

        #project-tree {
          display: flex;
          flex-direction: column;
        }

        #packages {
          display: flex;
          flex-direction: column;

          .loader {
            align-self: center;
            margin: 10px 0;
          }

          .tab-bar {
            display: flex;
            align-items: center;
            gap: 2px;
            padding: 4px 4px 0;
            margin-bottom: 6px;
          }

          .tab-tree-toggle {
            margin-right: 2px;

            &.active {
              color: var(--vscode-panelTitle-activeForeground);
            }
          }

          .tab {
            background: transparent;
            border: 1px solid transparent;
            color: var(--vscode-foreground);
            padding: 3px 10px;
            font-size: 11px;
            cursor: pointer;
            border-radius: 3px;
            opacity: 0.7;
          }

          .tab:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
          }

          .tab.active {
            opacity: 1;
            background-color: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground));
            color: var(--vscode-panelTitle-activeForeground);
            border-color: var(--vscode-focusBorder);
          }

          .tab-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 16px;
            height: 16px;
            padding: 0 4px;
            margin-left: 4px;
            font-size: 10px;
            font-weight: bold;
            border-radius: 8px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            line-height: 1;
          }

          .tab-content {
            flex: 1;
            overflow: hidden;
            display: flex;
            margin-top: 6px;
          }

          .tab-content.hidden {
            display: none;
          }

          .installed-packages {
            flex-direction: column;
          }

          .packages-container {
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            flex: 1;

            .package {
              margin-bottom: 3px;
            }

          }
        }

        #projects {
          display: flex;
          flex-direction: column;

          .packages-details-loader {
            align-self: center;
            margin-top: 20px;
          }

          .package-header-panel {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 8px 6px;
            border-bottom: 1px solid var(--vscode-panelSection-border);

            .package-icon-large {
              width: 32px;
              height: 32px;
              flex-shrink: 0;
            }

            .package-header-info {
              flex: 1;
              min-width: 0;
              display: flex;
              flex-direction: column;
              gap: 2px;

              .package-title-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;

                .package-title {
                  font-size: 14px;
                  font-weight: bold;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  white-space: nowrap;

                  a {
                    text-decoration: none;
                    color: var(--vscode-editor-foreground);
                  }

                  .package-link-icon {
                    vertical-align: middle;
                    font-size: 12px;
                    margin-right: 3px;
                  }
                }

                .source-badge {
                  display: flex;
                  align-items: center;
                  gap: 4px;
                  font-size: 11px;
                  color: var(--vscode-descriptionForeground);
                  white-space: nowrap;
                  flex-shrink: 0;

                  .codicon {
                    font-size: 12px;
                  }
                }
              }

              .package-authors-row {
                font-size: 11px;
                color: var(--vscode-descriptionForeground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              }
            }
          }

          .package-actions-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px;

            .version-selector {
              display: flex;
              align-items: center;
              gap: 4px;
              white-space: nowrap;
              min-width: 128px;
            }
          }

          .projects-panel-container {
            overflow-y: auto;
            overflow-x: hidden;

            .no-projects {
              display: flex;
              gap: 4px;
              margin-left: 6px;
            }

            .separator {
              margin: 10px 0px;
              height: 1px;
              background-color: var(--vscode-panelSection-border);
            }
          }
        }
      }
    `,
  ];

  private splitter: Split.Instance | null = null;
  private _packagesAc: AbortController | null = null;
  private _projectsAc: AbortController | null = null;
  private _projectsPackagesAc: AbortController | null = null;
  packagesPage: number = 0;
  packagesLoadingInProgress: boolean = false;

  @state() activeTab: TabId = "browse";
  @state() projects: Array<ProjectViewModel> = [];
  @state() selectedVersion: string = "";
  @state() selectedPackage: PackageViewModel | null = null;
  @state() packages: Array<PackageViewModel> = [];
  @state() projectsPackages: Array<PackageViewModel> = [];
  @state() updatesCount: number | null = null;
  @state() consolidateCount: number | null = null;
  @state() vulnerabilitiesCount: number | null = null;
  @state() filters: FilterEvent = {
    Prerelease: true,
    Query: "",
    SourceUrl: "",
    Sort: "relevance",
  };
  @state() noMorePackages: boolean = false;
  @state() packagesLoadingError: boolean = false;
  @state() packagesLoadingErrorMessage: string = "";
  @state() selectedProjectPaths: string[] = [];
  @state() showProjectTree: boolean = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.filters = {
      ...this.filters,
      SourceUrl: "",
      Prerelease: configuration.Configuration?.Prerelease ?? false,
    };
    // LoadPackages is triggered by search-bar's connectedCallback emitting filter-changed
    // connectedCallback cannot be async (Web Components spec) — void is intentional
    void this.LoadProjectsAsync();
  }

  override firstUpdated(): void {
    this.initSplitter();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.splitter?.destroy();
    this._packagesAc?.abort();
    this._projectsAc?.abort();
    this._projectsPackagesAc?.abort();
  }

  private initSplitter(): void {
    this.splitter?.destroy();
    this.splitter = null;

    const packages = this.shadowRoot!.getElementById("packages")!;
    const projects = this.shadowRoot!.getElementById("projects")!;

    if (this.showProjectTree) {
      const projectTree = this.shadowRoot!.getElementById("project-tree")!;
      this.splitter = Split([projectTree, packages, projects], {
        sizes: [20, 45, 35],
        minSize: [120, 200, 150],
        gutterSize: 4,
        gutter: this.makeGutter,
      });
    } else {
      this.splitter = Split([packages, projects], {
        sizes: [55, 45],
        minSize: [200, 150],
        gutterSize: 4,
        gutter: this.makeGutter,
      });
    }
  }

  private makeGutter(_index: number, direction: string): HTMLElement {
    const gutter = document.createElement("div");
    const gutterNested = document.createElement("div");
    gutter.className = `gutter gutter-${direction}`;
    gutterNested.className = "gutter-nested";
    gutter.appendChild(gutterNested);
    return gutter;
  }

  private async toggleProjectTreeAsync(): Promise<void> {
    this.showProjectTree = !this.showProjectTree;
    await this.updateComplete;
    this.initSplitter();
    await this.reloadChildViewsAsync();
  }

  get CurrentSource(): Source | undefined {
    return configuration.Configuration?.Sources.find(
      (s) => s.Url === this.filters.SourceUrl
    );
  }

  get NugetOrgPackageUrl(): string | null {
    const sourceUrl =
      this.selectedPackage?.SourceUrl || this.filters.SourceUrl;
    if (sourceUrl.startsWith(NUGET_ORG_PREFIX)) {
      return `https://www.nuget.org/packages/${this.selectedPackage?.Name}/${this.selectedVersion}`;
    }
    return null;
  }

  get PackageVersionUrl(): string {
    if (
      this.selectedPackage?.Status !== "Detailed" ||
      this.selectedPackage?.Model.Versions == undefined ||
      this.selectedPackage?.Model.Versions.length < 1 ||
      !this.selectedPackage?.Model.Version
    ) {
      return "";
    }

    return (
      this.selectedPackage?.Model.Versions.filter(
        (x) => x.Version == this.selectedVersion
      )[0]?.Id ?? ""
    );
  }

  // Stable empty-array reference so child Task args don't change on every render
  private static readonly _emptyPaths: string[] = [];

  private get effectiveProjectPaths(): string[] {
    return this.showProjectTree ? this.selectedProjectPaths : PackagesView._emptyPaths;
  }

  private get filteredProjects(): Array<ProjectViewModel> {
    if (!this.showProjectTree || this.selectedProjectPaths.length === 0) return this.projects;
    return this.projects.filter((p) =>
      this.selectedProjectPaths.includes(p.Path)
    );
  }

  private async handleTabKeydownAsync(e: KeyboardEvent): Promise<void> {
    const tabs: TabId[] = ["browse", "installed", "updates", "consolidate", "vulnerabilities"];
    const currentIdx = tabs.indexOf(this.activeTab);
    let newIdx = currentIdx;

    switch (e.key) {
      case "ArrowRight":
        newIdx = (currentIdx + 1) % tabs.length;
        break;
      case "ArrowLeft":
        newIdx = (currentIdx - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        newIdx = 0;
        break;
      case "End":
        newIdx = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    await this.setTabAsync(tabs[newIdx] as TabId);
    const tabButtons = this.shadowRoot?.querySelectorAll('[role="tab"]');
    (tabButtons?.[newIdx] as HTMLElement)?.focus();
  }

  async setTabAsync(tab: TabId): Promise<void> {
    if (tab === this.activeTab) return;
    this.activeTab = tab;
    await this.updateComplete;
    if (tab === "updates") {
      await (this.shadowRoot?.querySelector("updates-view") as UpdatesView | null)?.LoadOutdatedPackagesAsync();
    } else if (tab === "consolidate") {
      await (this.shadowRoot?.querySelector("consolidate-view") as ConsolidateView | null)?.LoadInconsistentPackagesAsync();
    } else if (tab === "vulnerabilities") {
      await (this.shadowRoot?.querySelector("vulnerabilities-view") as VulnerabilitiesView | null)?.LoadVulnerablePackagesAsync();
    }
  }

  private async onChildPackageSelectedAsync(e: CustomEvent<{ packageId: string; sourceUrl?: string }>): Promise<void> {
    const { packageId, sourceUrl } = e.detail;

    // Check if we already have this package in projectsPackages (installed)
    const existing = this.projectsPackages.find((p) => p.Id === packageId);
    if (existing) {
      await this.SelectPackageAsync(existing);
      return;
    }

    // Check if we have it in browse packages
    const browsePkg = this.packages.find((p) => p.Id === packageId);
    if (browsePkg) {
      await this.SelectPackageAsync(browsePkg);
      return;
    }

    // Create a new PackageViewModel with MissingDetails — SelectPackage will fetch details
    const pkg = new PackageViewModel(
      {
        Id: packageId,
        Name: packageId,
        IconUrl: "",
        Authors: [],
        Description: "",
        LicenseUrl: "",
        ProjectUrl: "",
        TotalDownloads: 0,
        Verified: false,
        Version: "",
        InstalledVersion: "",
        Versions: [],
        Tags: [],
        Registration: "",
      },
      "MissingDetails"
    );
    if (sourceUrl) pkg.SourceUrl = sourceUrl;
    await this.SelectPackageAsync(pkg);
  }

  async setSearchQueryAsync(query: string): Promise<void> {
    await this.setTabAsync("browse");
    await this.updateComplete;
    const searchBar = this.shadowRoot?.querySelector("search-bar") as SearchBar | null;
    searchBar?.setSearchQuery(query);
  }

  private async OnProjectSelectionChangedAsync(paths: string[]): Promise<void> {
    this.selectedProjectPaths = paths;
    await this.reloadChildViewsAsync();
    this.debouncedLoadProjectsPackages();
  }

  private async reloadChildViewsAsync(forceReload: boolean = false): Promise<void> {
    const updates = this.shadowRoot?.querySelector("updates-view") as UpdatesView | null;
    const consolidate = this.shadowRoot?.querySelector("consolidate-view") as ConsolidateView | null;
    const vulnerabilities = this.shadowRoot?.querySelector("vulnerabilities-view") as VulnerabilitiesView | null;
    await Promise.all([
      updates?.LoadOutdatedPackagesAsync(forceReload),
      consolidate?.LoadInconsistentPackagesAsync(forceReload),
      vulnerabilities?.LoadVulnerablePackagesAsync(forceReload),
    ]);
  }

  private debouncedLoadProjectsPackages = lodash.debounce(async () => {
    await this.LoadProjectsPackagesAsync();
  }, 300);

  async LoadProjectsPackagesAsync(forceReload: boolean = false, _signal?: AbortSignal): Promise<void> {
    this._projectsPackagesAc?.abort();
    const ac = new AbortController();
    this._projectsPackagesAc = ac;
    const projectsToUse =
      this.selectedProjectPaths.length > 0
        ? this.projects.filter((p) =>
            this.selectedProjectPaths.includes(p.Path)
          )
        : this.projects;

    const packages = projectsToUse
      ?.flatMap((p) => p.Packages)
      .filter((x) =>
        x.Id.toLowerCase().includes(this.filters.Query?.toLowerCase())
      );

    const grouped = packages.reduce(
      (
        acc: {
          [key: string]: { versions: string[]; allowsUpdate: boolean };
        },
        item
      ) => {
        const { Id, Version, IsPinned } = item;

        if (!acc[Id]) {
          acc[Id] = { versions: [], allowsUpdate: false };
        }

        if (acc[Id].versions.indexOf(Version) < 0) {
          acc[Id].versions.push(Version);
        }

        if (!IsPinned) {
          acc[Id].allowsUpdate = true;
        }

        return acc;
      },
      {}
    );

    this.projectsPackages = Object.entries(grouped).map(([Id, data]) => {
      const pkg = new PackageViewModel(
        {
          Id: Id,
          Name: Id,
          IconUrl: "",
          Versions: data.versions.map((x) => ({
            Id: "",
            Version: x,
          })),
          InstalledVersion:
            data.versions.length > 1
              ? "Multiple"
              : (data.versions[0] ?? ""),
          Version: "",
          Description: "",
          LicenseUrl: "",
          ProjectUrl: "",
          Verified: false,
          TotalDownloads: 0,
          Tags: [],
          Registration: "",
          Authors: [],
        },
        "MissingDetails"
      );
      pkg.AllowsUpdate = data.allowsUpdate;
      return pkg;
    });

    const total = this.projectsPackages.length;
    let completed = 0;

    if (total > 0) {
      hostApi.updateStatusBarAsync({
        Percentage: 0,
        Message: "Loading installed packages...",
      });
    }

    try {
      const CONCURRENCY = 5;
      let idx = 0;
      const runNext = async (): Promise<void> => {
        while (idx < this.projectsPackages.length) {
          if (ac.signal.aborted) return;
          const pkg = this.projectsPackages[idx++]!;
          await this.UpdatePackageAsync(pkg, forceReload, ac.signal);
          if (ac.signal.aborted) return;
          completed++;
          void hostApi.updateStatusBarAsync({
            Percentage: (completed / total) * 100,
            Message: "Loading installed packages...",
          });
        }
      };
      const workers = Array.from({ length: Math.min(CONCURRENCY, this.projectsPackages.length) }, runNext);
      await Promise.allSettled(workers);
    } finally {
      if (!ac.signal.aborted) {
        this.projectsPackages = [...this.projectsPackages];
        if (total > 0) {
          void hostApi.updateStatusBarAsync({ Percentage: null });
        }
      }
    }
  }

  async OnProjectUpdatedAsync(event: CustomEvent): Promise<void> {
    const isCpmEnabled = event.detail?.isCpmEnabled ?? false;
    if (isCpmEnabled) {
      await this.LoadProjectsAsync();
    } else {
      await this.LoadProjectsPackagesAsync();
    }
  }

  private async UpdatePackageAsync(
    projectPackage: PackageViewModel,
    forceReload: boolean = false,
    signal?: AbortSignal
  ): Promise<void> {
    const updatePkgReq: Parameters<typeof hostApi.getPackageAsync>[0] = {
      Id: projectPackage.Id,
      Url: this.filters.SourceUrl,
      Prerelease: this.filters.Prerelease,
      ForceReload: forceReload,
    };
    if (this.CurrentSource?.Name !== undefined) updatePkgReq.SourceName = this.CurrentSource.Name;
    if (this.CurrentSource?.PasswordScriptPath !== undefined) updatePkgReq.PasswordScriptPath = this.CurrentSource.PasswordScriptPath;
    const result = await hostApi.getPackageAsync(updatePkgReq, signal);

    if (signal?.aborted) return;
    if (!result.ok || !result.value.Package) {
      projectPackage.Status = "Error";
    } else {
      if (projectPackage.Version !== "") result.value.Package.Version = "";
      projectPackage.UpdatePackage(
        result.value.Package,
        result.value.SourceUrl
      );
      projectPackage.Status = "Detailed";
    }
  }

  async UpdatePackagesFiltersAsync(filters: FilterEvent): Promise<void> {
    const prereleaseChanged = this.filters.Prerelease !== filters.Prerelease;
    const sourceChanged = this.filters.SourceUrl !== filters.SourceUrl;
    this.filters = filters;
    // Only clear the NuGet API factory cache when the source changes.
    // Prerelease changes don't need it: the package cache key is "${id}::${prerelease}",
    // so a new prerelease state already results in a natural cache miss.
    // Clearing the factory on every prerelease toggle destroyed all NuGetApi instances,
    // forcing expensive re-creation (config file reads, source index HTTP calls) for every
    // installed package — causing ~15 s delays.
    await this.LoadPackagesAsync(false, sourceChanged);
    await this.LoadProjectsPackagesAsync(sourceChanged);

    // Only explicitly reload child views when the source changes (force-reload to bypass cache).
    // Prerelease changes are handled automatically: the child Task args include `prerelease`
    // as a bound property, so a prerelease toggle already triggers an auto-rerun.
    if (sourceChanged) {
      await this.reloadChildViewsAsync(true);
    }
  }

  async SelectPackageAsync(
    selectedPackage: PackageViewModel
  ): Promise<void> {
    this.packages
      .filter((x) => x.Selected)
      .forEach((x) => (x.Selected = false));
    this.projectsPackages
      .filter((x) => x.Selected)
      .forEach((x) => (x.Selected = false));
    selectedPackage.Selected = true;
    this.selectedPackage = selectedPackage;

    if (this.selectedPackage.Status === "MissingDetails") {
      const packageToUpdate = this.selectedPackage;
      const selectPkgReq: Parameters<typeof hostApi.getPackageAsync>[0] = {
        Id: packageToUpdate.Id,
        Url: this.filters.SourceUrl,
        Prerelease: this.filters.Prerelease,
      };
      if (this.CurrentSource?.Name !== undefined) selectPkgReq.SourceName = this.CurrentSource.Name;
      if (this.CurrentSource?.PasswordScriptPath !== undefined) selectPkgReq.PasswordScriptPath = this.CurrentSource.PasswordScriptPath;
      const result = await hostApi.getPackageAsync(selectPkgReq);

      if (!result.ok || !result.value.Package) {
        packageToUpdate.Status = "Error";
      } else {
        if (packageToUpdate.Version !== "") {
          result.value.Package.Version = "";
        }
        packageToUpdate.UpdatePackage(
          result.value.Package,
          result.value.SourceUrl
        );
        packageToUpdate.Status = "Detailed";
      }
    }

    this.selectedVersion = this.selectedPackage.Version;
    this.requestUpdate();
  }

  async PackagesScrollEventAsync(target: HTMLElement): Promise<void> {
    if (this.packagesLoadingInProgress || this.noMorePackages) return;
    if (
      target.scrollTop + target.getBoundingClientRect().height >
      target.scrollHeight - PACKAGE_CONTAINER_SCROLL_MARGIN
    ) {
      await this.LoadPackagesAsync(true);
    }
  }

  async ReloadInvokedAsync(
    forceReload: boolean = false
  ): Promise<void> {
    await this.LoadPackagesAsync(false, forceReload);
    await this.LoadProjectsAsync(forceReload);
    await this.reloadChildViewsAsync(forceReload);
  }

  async LoadPackagesAsync(
    append: boolean = false,
    forceReload: boolean = false
  ): Promise<void> {
    if (!append) {
      this._packagesAc?.abort();
      this._packagesAc = new AbortController();
      this.packagesPage = 0;
      this.selectedPackage = null;
      this.packages = [];
    }
    const ac = this._packagesAc ?? new AbortController();

    const buildRequest = (): Parameters<typeof hostApi.getPackagesAsync>[0] => {
      const req: Parameters<typeof hostApi.getPackagesAsync>[0] = {
        Url: this.filters.SourceUrl,
        Filter: this.filters.Query,
        Prerelease: this.filters.Prerelease,
        Skip: this.packagesPage * PACKAGE_FETCH_TAKE,
        Take: PACKAGE_FETCH_TAKE,
        ForceReload: forceReload,
      };
      if (this.CurrentSource?.Name !== undefined) req.SourceName = this.CurrentSource.Name;
      if (this.CurrentSource?.PasswordScriptPath !== undefined) req.PasswordScriptPath = this.CurrentSource.PasswordScriptPath;
      return req;
    };

    this.packagesLoadingError = false;
    this.packagesLoadingInProgress = true;
    this.noMorePackages = false;

    const requestObject = buildRequest();
    const result = await hostApi.getPackagesAsync(requestObject, ac.signal);

    if (ac.signal.aborted) return;

    if (!result.ok) {
      this.packagesLoadingError = true;
      this.packagesLoadingErrorMessage = result.error;
      this.packagesLoadingInProgress = false;
    } else {
      const packagesViewModels = result.value.Packages.map(
        (x) => new PackageViewModel(x)
      );
      if (packagesViewModels.length < requestObject.Take) {
        this.noMorePackages = true;
      }
      this.packages = [...this.packages, ...packagesViewModels];
      this.packagesPage++;
      this.packagesLoadingInProgress = false;
    }
  }

  async LoadProjectsAsync(forceReload: boolean = false): Promise<void> {
    this._projectsAc?.abort();
    const ac = new AbortController();
    this._projectsAc = ac;

    this.projects = [];
    const result = await hostApi.getProjectsAsync({ ForceReload: forceReload }, ac.signal);

    if (ac.signal.aborted) return;

    if (result.ok) {
      this.projects = result.value.Projects.map(
        (x) => new ProjectViewModel(x)
      );
      const validPaths = new Set(this.projects.map((p) => p.Path));
      this.selectedProjectPaths = this.selectedProjectPaths.filter((p) => validPaths.has(p));
      if (this.selectedProjectPaths.length === 0) {
        this.selectedProjectPaths = this.projects.map((p) => p.Path);
      }
      await this.LoadProjectsPackagesAsync(forceReload);
    }
  }

  // -- Render helpers --

  private renderBrowseTab(): unknown {
    return html`
      <div
        class="packages-container"
        @scroll=${async (e: Event) =>
          await this.PackagesScrollEventAsync(e.target as HTMLElement)}
      >
        ${this.packagesLoadingError
          ? html`<div class="error">
              <span class="codicon codicon-error"></span>
              ${this.packagesLoadingErrorMessage || "Failed to fetch packages"}
              <button class="icon-btn" title="Retry" aria-label="Retry" @click=${async () => await this.LoadPackagesAsync()}>
                <span class="codicon codicon-refresh"></span>
              </button>
            </div>`
          : html`
              ${this.packages.map(
                (pkg) => html`
                  <package-row
                    .package=${pkg}
                    @click=${async () => await this.SelectPackageAsync(pkg)}
                  ></package-row>
                `
              )}
              ${!this.noMorePackages
                ? html`<span class="spinner medium loader"></span>`
                : nothing}
            `}
      </div>
    `;
  }

  private get filteredInstalledPackages(): PackageViewModel[] {
    return this.projectsPackages.filter((pkg) => {
      const version = pkg.InstalledVersion;
      const isPrerelease = version.includes("-");
      return this.filters.Prerelease ? isPrerelease : !isPrerelease;
    });
  }

  private renderInstalledTab(): unknown {
    const packages = this.filteredInstalledPackages;
    return html`
      <div class="packages-container installed-packages">
        ${packages.length === 0 && this.projectsPackages.length > 0
          ? html`
              <div class="empty">
                <span class="codicon codicon-info"></span>
                No ${this.filters.Prerelease ? "prerelease" : "stable"} packages installed
              </div>
            `
          : packages.map(
              (pkg) => html`
                <package-row
                  .showInstalledVersion=${true}
                  .package=${pkg}
                  .revision=${pkg.Revision}
                  @click=${async () => await this.SelectPackageAsync(pkg)}
                ></package-row>
              `
            )}
      </div>
    `;
  }


  private renderPackageTitle(): unknown {
    const nugetUrl = this.NugetOrgPackageUrl;
    if (nugetUrl != null) {
      return html`<a target="_blank" href=${nugetUrl}>
        <span class="package-link-icon codicon codicon-link-external"></span
        >${this.selectedPackage?.Name}</a
      >`;
    }
    return html`${this.selectedPackage?.Name}`;
  }

  private get selectedSourceName(): string {
    const sourceUrl = this.selectedPackage?.SourceUrl || this.filters.SourceUrl;
    if (!sourceUrl) return "";
    if (sourceUrl.startsWith(NUGET_ORG_PREFIX)) return "nuget.org";
    const source = configuration.Configuration?.Sources.find((s) => s.Url === sourceUrl);
    return source?.Name ?? "";
  }

  private get selectedPackageIconUrl(): string {
    const url = this.selectedPackage?.IconUrl;
    if (!url) return "https://nuget.org/Content/gallery/img/default-package-icon.svg";
    return url;
  }

  private renderDetailedPackage(): unknown {
    const sourceName = this.selectedSourceName;

    return html`
      <div class="package-header-panel">
        <img
          class="package-icon-large"
          alt=""
          src=${this.selectedPackageIconUrl}
          @error=${(e: Event) => {
            (e.target as HTMLImageElement).src = "https://nuget.org/Content/gallery/img/default-package-icon.svg";
          }}
        />
        <div class="package-header-info">
          <div class="package-title-row">
            <span class="package-title">${this.renderPackageTitle()}</span>
            ${sourceName
              ? html`<span class="source-badge">
                  <span class="codicon codicon-globe"></span>
                  ${sourceName}
                </span>`
              : nothing}
          </div>
          ${this.selectedPackage?.Authors
            ? html`<span class="package-authors-row">by ${this.selectedPackage.Authors}</span>`
            : nothing}
        </div>
      </div>
      <div class="package-actions-row">
        <div class="version-selector">
          <custom-dropdown
            .options=${(this.selectedPackage?.Versions || []).map((v): DropdownOption => ({ value: v, label: v }))}
            .value=${this.selectedVersion}
            ariaLabel="Package version"
            @change=${(e: CustomEvent<string>) => { this.selectedVersion = e.detail; }}
          ></custom-dropdown>
          <button class="icon-btn" @click=${() => this.LoadProjectsAsync()}>
            <span class="codicon codicon-refresh"></span>
          </button>
        </div>
      </div>
      <div class="projects-panel-container">
        ${this.projects.length > 0
          ? this.filteredProjects.map(
              (project) => html`
                <project-row
                  @project-updated=${(e: CustomEvent) =>
                    this.OnProjectUpdatedAsync(e)}
                  .project=${project}
                  .packageId=${this.selectedPackage?.Name}
                  .packageVersion=${this.selectedVersion}
                  .sourceUrl=${this.selectedPackage?.SourceUrl}
                ></project-row>
              `
            )
          : html`<div class="no-projects">
              <span class="codicon codicon-info"></span> No projects found
            </div>`}
        <div class="separator"></div>
        <package-details
          .package=${this.selectedPackage}
          .packageVersionUrl=${this.PackageVersionUrl}
          .source=${this.selectedPackage?.SourceUrl || this.filters.SourceUrl}
          .passwordScriptPath=${this.CurrentSource?.PasswordScriptPath}
          .selectedVersion=${this.selectedVersion}
        ></package-details>
      </div>
    `;
  }

  private renderMissingDetailsPackage(): unknown {
    if (this.selectedPackage?.Status === "MissingDetails") {
      return html`<span
        class="spinner medium packages-details-loader"
      ></span>`;
    }
    return html`<div class="error">
      <span class="codicon codicon-error"></span> Failed to fetch the
      package from the selected registry.
    </div>`;
  }

  private renderSelectedPackagePanel(): unknown {
    if (this.selectedPackage == null) return nothing;

    if (this.selectedPackage.Status === "Detailed") {
      return this.renderDetailedPackage();
    }
    return this.renderMissingDetailsPackage();
  }

  override render(): unknown {
    return html`
      <div class="container">
        ${this.showProjectTree
          ? html`<div class="col" id="project-tree">
              <project-tree
                .projects=${this.projects}
                @selection-changed=${async (e: CustomEvent<string[]>) =>
                  await this.OnProjectSelectionChangedAsync(e.detail)}
              ></project-tree>
            </div>`
          : nothing}

        <div class="col" id="packages">
          <div class="tab-bar" role="tablist" @keydown=${async (e: KeyboardEvent) => await this.handleTabKeydownAsync(e)}>
            <button
              class="icon-btn tab-tree-toggle ${this.showProjectTree ? "active" : ""}"
              title="${this.showProjectTree ? "Hide project tree" : "Show project tree"}"
              aria-label="${this.showProjectTree ? "Hide project tree" : "Show project tree"}"
              aria-pressed="${this.showProjectTree}"
              @click=${async () => await this.toggleProjectTreeAsync()}
            >
              <span class="codicon codicon-list-tree"></span>
            </button>
            <button
              class="tab ${this.activeTab === "browse" ? "active" : ""}"
              role="tab"
              aria-selected=${this.activeTab === "browse"}
              tabindex=${this.activeTab === "browse" ? 0 : -1}
              @click=${async () => await this.setTabAsync("browse")}
            >
              BROWSE
            </button>
            <button
              class="tab ${this.activeTab === "installed" ? "active" : ""}"
              role="tab"
              aria-selected=${this.activeTab === "installed"}
              tabindex=${this.activeTab === "installed" ? 0 : -1}
              @click=${async () => await this.setTabAsync("installed")}
            >
              INSTALLED${this.filteredInstalledPackages.length > 0
                ? html`<span class="tab-badge">${this.filteredInstalledPackages.length}</span>`
                : nothing}
            </button>
            <button
              class="tab ${this.activeTab === "updates" ? "active" : ""}"
              role="tab"
              aria-selected=${this.activeTab === "updates"}
              tabindex=${this.activeTab === "updates" ? 0 : -1}
              @click=${async () => await this.setTabAsync("updates")}
            >
              UPDATES${this.updatesCount !== null
                ? html`<span class="tab-badge">${this.updatesCount}</span>`
                : nothing}
            </button>
            <button
              class="tab ${this.activeTab === "consolidate" ? "active" : ""}"
              role="tab"
              aria-selected=${this.activeTab === "consolidate"}
              tabindex=${this.activeTab === "consolidate" ? 0 : -1}
              @click=${async () => await this.setTabAsync("consolidate")}
            >
              CONSOLIDATE${this.consolidateCount !== null
                ? html`<span class="tab-badge">${this.consolidateCount}</span>`
                : nothing}
            </button>
            <button
              class="tab ${this.activeTab === "vulnerabilities" ? "active" : ""}"
              role="tab"
              aria-selected=${this.activeTab === "vulnerabilities"}
              tabindex=${this.activeTab === "vulnerabilities" ? 0 : -1}
              @click=${async () => await this.setTabAsync("vulnerabilities")}
            >
              VULNERABILITIES${this.vulnerabilitiesCount !== null
                ? html`<span class="tab-badge">${this.vulnerabilitiesCount}</span>`
                : nothing}
            </button>
          </div>
          <search-bar
            @reload-invoked=${async (e: CustomEvent<boolean>) =>
              await this.ReloadInvokedAsync(e.detail)}
            @filter-changed=${async (e: CustomEvent<FilterEvent>) =>
              await this.UpdatePackagesFiltersAsync(e.detail)}
          ></search-bar>
          <div class="tab-content ${this.activeTab === "browse" ? "" : "hidden"}" role="tabpanel" aria-label="browse tab">
            ${this.renderBrowseTab()}
          </div>
          <div class="tab-content ${this.activeTab === "installed" ? "" : "hidden"}" role="tabpanel" aria-label="installed tab">
            ${this.renderInstalledTab()}
          </div>
          <div class="tab-content ${this.activeTab === "updates" ? "" : "hidden"}" role="tabpanel" aria-label="updates tab">
            <updates-view
              .prerelease=${this.filters.Prerelease}
              .projectPaths=${this.effectiveProjectPaths}
              .sourceUrl=${this.filters.SourceUrl}
              .filterQuery=${this.filters.Query}
              @count-changed=${(e: CustomEvent<number>) => { this.updatesCount = e.detail; }}
              @package-selected=${(e: CustomEvent) => this.onChildPackageSelectedAsync(e)}
            ></updates-view>
          </div>
          <div class="tab-content ${this.activeTab === "consolidate" ? "" : "hidden"}" role="tabpanel" aria-label="consolidate tab">
            <consolidate-view
              .projectPaths=${this.effectiveProjectPaths}
              @count-changed=${(e: CustomEvent<number>) => { this.consolidateCount = e.detail; }}
              @package-selected=${(e: CustomEvent) => this.onChildPackageSelectedAsync(e)}
            ></consolidate-view>
          </div>
          <div class="tab-content ${this.activeTab === "vulnerabilities" ? "" : "hidden"}" role="tabpanel" aria-label="vulnerabilities tab">
            <vulnerabilities-view
              .projectPaths=${this.effectiveProjectPaths}
              @count-changed=${(e: CustomEvent<number>) => { this.vulnerabilitiesCount = e.detail; }}
              @package-selected=${(e: CustomEvent) => this.onChildPackageSelectedAsync(e)}
            ></vulnerabilities-view>
          </div>
        </div>

        <div class="col" id="projects">
          ${this.renderSelectedPackagePanel()}
        </div>
      </div>
      <nuget-output-log></nuget-output-log>
      <nuget-license-dialog></nuget-license-dialog>
    `;
  }
}
