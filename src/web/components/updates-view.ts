import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";

import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import { buildFrameworkOptions, getFrameworkGroupKey, getFrameworkLabel, matchesFrameworkSelection, SHARED_FRAMEWORK } from "@/common/framework";
import { OutdatedPackageViewModel, PackageViewModel } from "../types";
import type { GetOutdatedPackagesRequest, GetOutdatedPackagesResponse } from "@/common/rpc/types";
import "./package-row";

@customElement("updates-view")
export class UpdatesView extends LitElement {
  static override styles = [
    codicon,
    scrollableBase,
    sharedStyles,
    css`
      :host {
        display: block;
        flex: 1;
        width: 100%;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }

      .updates-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-height: 0;
        .outdated-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 5px 8px 0;
          padding: 10px 12px;
          border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
          border-radius: var(--npm-radius, 10px);
          background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
        }


          package-row {
            flex: 1;
            min-width: 0;
          }



          .row-actions {
            display: flex;
            align-items: center;
            flex-shrink: 0;
          }

          .package-list {
            flex: 0 0 auto;
          }

          .group-select {
            margin: 0;
            accent-color: var(--vscode-focusBorder);
          }

          .conflicts {
            margin: 6px 8px 10px;
            border: 1px solid var(--vscode-inputValidation-warningBorder, var(--npm-border, var(--vscode-panelSection-border)));
            border-radius: 8px;
            background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
          }

          .conflicts-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 7px 10px;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--npm-border, var(--vscode-panelSection-border));
          }

          .conflicts-list {
            list-style: none;
            margin: 0;
            padding: 0;
          }

          .conflict-row {
            display: flex;
            flex-direction: column;
            gap: 3px;
            padding: 8px 10px;
            font-size: 11px;
          }

          .conflict-row + .conflict-row {
            border-top: 1px solid color-mix(in srgb, var(--npm-border, var(--vscode-panelSection-border)) 60%, transparent);
          }

          .conflict-title {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 6px;
          }

          .conflict-id {
            font-weight: 600;
            color: var(--vscode-foreground);
          }

          .conflict-version,
          .conflict-reason {
            color: var(--vscode-descriptionForeground);
            line-height: 1.45;
          }

          .conflict-reason {
            font-family: var(--vscode-editor-font-family, monospace);
          }
        }

      }
    `,
  ];

  @state() packages: OutdatedPackageViewModel[] = [];
  @state() blockedPackages: Array<{
    Id: string;
    InstalledVersion: string;
    BlockedVersion: string;
    Reason: string;
    BlockedBy: Array<{ PackageId: string; InstalledVersion: string; Range: string }>;
  }> = [];
  @state() isRefreshing: boolean = false;
  @state() isUpdating: boolean = false;
  @state() statusText: string = "";
  @property() selectedFramework: string = "";
  @property({ type: Boolean }) prerelease: boolean = false;
  @property({ attribute: false }) projectPaths: string[] = [];
  @property() sourceUrl: string = "";
  @property() filterQuery: string = "";
  @property({ attribute: false }) availableFrameworks: Array<{ value: string; label: string }> = [];

  private buildRequest(
    projectPaths: string[],
    sourceUrl: string,
    prerelease: boolean,
    forceReload: boolean,
    preferCache = false
  ): GetOutdatedPackagesRequest {
    const req: GetOutdatedPackagesRequest = { Prerelease: prerelease };
    if (projectPaths.length > 0) req.ProjectPaths = projectPaths;
    if (sourceUrl) req.SourceUrl = sourceUrl;
    if (forceReload) req.ForceReload = true;
    if (preferCache) req.PreferCache = true;
    return req;
  }

  private packageKey(pkg: OutdatedPackageViewModel): string {
    return `${pkg.Id}\0${pkg.CpmCondition}\0${pkg.CpmFramework}`;
  }

  private applyScan(response: GetOutdatedPackagesResponse, fromCache: boolean): void {
    const previousSelection = new Map<string, boolean>();
    for (const pkg of this.packages) {
      previousSelection.set(this.packageKey(pkg), pkg.Selected);
    }

    const packages = (response.Packages ?? []).map((pkg) => new OutdatedPackageViewModel(pkg));
    for (const pkg of packages) {
      pkg.Selected = previousSelection.get(this.packageKey(pkg)) ?? true;
    }

    this.packages = packages;
    this.blockedPackages = response.BlockedPackages ?? [];
    this.isRefreshing = fromCache;
    if (fromCache) {
      const scannedAt = response.ScannedAt ? new Date(response.ScannedAt).toLocaleTimeString() : "";
      this.statusText = scannedAt
        ? `Showing cached results from ${scannedAt} — refreshing…`
        : "Refreshing…";
    } else {
      this.statusText = "";
    }

    this.dispatchEvent(new CustomEvent<number>("count-changed", {
      detail: packages.length,
      bubbles: true,
      composed: true,
    }));
    this.dispatchEvent(new CustomEvent("framework-options-changed", {
      detail: this.frameworkOptions,
      bubbles: true,
      composed: true,
    }));
  }

  private _loadTask = new Task(this, {
    task: async ([projectPaths, sourceUrl, prerelease, forceReload], { signal }) => {
      const result = await hostApi.getOutdatedPackagesAsync(
        this.buildRequest(projectPaths, sourceUrl, prerelease, forceReload),
        signal
      );
      if (!result.ok) throw new Error("Failed to check for updates");
      return result.value;
    },
    args: () => [this.projectPaths, this.sourceUrl, this.prerelease, false] as [string[], string, boolean, boolean],
    onComplete: (response) => {
      this.applyScan(response, false);
    },
    onError: () => {
      this.isRefreshing = false;
    },
  });

  get frameworkOptions(): Array<{ value: string; label: string }> {
    const values = [
      ...this.packages.map((pkg) => pkg.CpmFramework),
      ...this.availableFrameworks.map((option) => option.value),
    ];
    return buildFrameworkOptions(values, this.packages.some((pkg) => pkg.CpmFramework === ""));
  }

  private get visiblePackages(): OutdatedPackageViewModel[] {
    let list = this.packages;
    if (this.selectedFramework !== "" && this.frameworkOptions.length > 0) {
      list = list.filter((pkg) =>
        matchesFrameworkSelection(this.selectedFramework, pkg.CpmFramework)
      );
    }
    if (!this.filterQuery) return list;
    const q = this.filterQuery.toLowerCase();
    return list.filter((p) => p.Id.toLowerCase().includes(q));
  }

  private get groupedVisiblePackages(): Array<{ key: string; label: string; packages: OutdatedPackageViewModel[] }> {
    const groups = new Map<string, OutdatedPackageViewModel[]>();
    for (const pkg of this.visiblePackages) {
      const key = getFrameworkGroupKey(this.selectedFramework, pkg.CpmFramework);
      const list = groups.get(key) ?? [];
      list.push(pkg);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([key, packages]) => ({
        key,
        label: key ? getFrameworkLabel(key) : getFrameworkLabel(SHARED_FRAMEWORK),
        packages,
      }))
      .sort((a, b) => {
        if (a.key === "" && b.key !== "") return -1;
        if (a.key !== "" && b.key === "") return 1;
        return a.key.localeCompare(b.key);
      });
  }

  private get hasMultipleTfmsSelected(): boolean {
    const counts = new Map<string, number>();
    for (const pkg of this.visiblePackages) {
      if (!pkg.Selected || pkg.CpmFramework === "") continue;
      counts.set(pkg.Id, (counts.get(pkg.Id) ?? 0) + 1);
    }
    return [...counts.values()].some((count) => count > 1);
  }

  private async updateAllSelectedAsync(): Promise<void> {
    const selected = this.visiblePackages.filter((pkg) => pkg.Selected && !pkg.IsUpdating);
    if (selected.length === 0) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Update ${selected.length} package${selected.length !== 1 ? "s" : ""}?`,
      Detail: selected.map((pkg) => `${pkg.Id}: ${pkg.InstalledVersion} -> ${pkg.LatestVersion}`).join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    await this.updatePackagesSequentiallyAsync(selected);
  }

  private async updateAllTfmsAsync(): Promise<void> {
    const selectedIds = new Set(
      this.visiblePackages.filter((pkg) => pkg.Selected).map((pkg) => pkg.Id)
    );
    const targets = this.packages.filter(
      (pkg) => selectedIds.has(pkg.Id) && pkg.CpmFramework !== "" && !pkg.IsUpdating
    );
    if (targets.length === 0) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Update ${targets.length} framework-scoped package version${targets.length !== 1 ? "s" : ""}?`,
      Detail: targets
        .map((pkg) => `${pkg.Id} [${pkg.CpmFramework}]: ${pkg.InstalledVersion} -> ${pkg.LatestVersion}`)
        .join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    await this.updatePackagesSequentiallyAsync(targets);
  }

  private get allVisibleSelected(): boolean {
    const visible = this.visiblePackages;
    return visible.length > 0 && visible.every((p) => p.Selected);
  }

  private toggleSelectAll(): void {
    const selectAll = !this.allVisibleSelected;
    this.visiblePackages.forEach((p) => { p.Selected = selectAll; });
    this.requestUpdate();
  }

  private toggleGroupSelection(packages: OutdatedPackageViewModel[], selected: boolean): void {
    packages.forEach((pkg) => { pkg.Selected = selected; });
    this.requestUpdate();
  }

  async LoadOutdatedPackagesAsync(forceReload: boolean = false): Promise<void> {
    this.packages = [];
    this.blockedPackages = [];
    this.isRefreshing = false;
    this.statusText = "";

    // Paint the previous scan immediately, then refresh in the background. The
    // cache is best-effort: a miss or failure must never block the live scan.
    if (!forceReload) {
      try {
        const cached = await hostApi.getOutdatedPackagesAsync(
          this.buildRequest(this.projectPaths, this.sourceUrl, this.prerelease, false, true)
        );
        if (cached.ok && ((cached.value.Packages?.length ?? 0) > 0 || (cached.value.BlockedPackages?.length ?? 0) > 0)) {
          this.applyScan(cached.value, true);
        }
      } catch (err) {
        console.debug("UpdatesView: cached scan unavailable", err);
      }
    }

    try {
      await this._loadTask.run([this.projectPaths, this.sourceUrl, this.prerelease, forceReload]);
    } catch (err) {
      this.isRefreshing = false;
      if (this.packages.length > 0) {
        this.statusText = "Showing cached results — refresh failed";
      }
      console.error(err);
    }
  }

  private async updateSingleAsync(
    pkg: OutdatedPackageViewModel,
    skipRestore = false,
    version = pkg.LatestVersion
  ): Promise<boolean> {
    if (this.isRefreshing) return false;
    pkg.IsUpdating = true;
    this.requestUpdate();
    try {
      const result = await hostApi.batchUpdatePackagesAsync({
        // The host runs the whole transaction: snapshot, write, restore and
        // roll back if restore fails.
        SkipRestore: skipRestore,
        Transactional: true,
        Updates: [
          {
            PackageId: pkg.Id,
            Version: version,
            ProjectPaths: pkg.Projects.map((p) => p.Path),
            ...(pkg.CpmCondition ? { CpmCondition: pkg.CpmCondition } : {}),
            ...(pkg.CpmFramework ? { CpmTfm: pkg.CpmFramework } : {}),
            Scope: pkg.CpmCondition ? "group" : "unconditional",
          },
        ],
      });
      const succeeded = result.ok && !result.value.RolledBack && result.value.Results.every((r) => r.Success);
      if (succeeded) {
        // Condition + TFM identify a framework-scoped row, so updating the
        // net10.0 line does not also remove the net11.0 entry.
        this.packages = this.packages.filter(
          (p) => !(p.Id === pkg.Id && p.CpmCondition === pkg.CpmCondition && p.CpmFramework === pkg.CpmFramework)
        );
        this.dispatchEvent(new CustomEvent<number>("count-changed", {
          detail: this.packages.length,
          bubbles: true,
          composed: true,
        }));
        this.statusText =
          this.packages.length > 0
            ? `${this.packages.length} update${this.packages.length !== 1 ? "s" : ""} available`
            : "All packages are up to date";
        await hostApi.updateBadgeAsync({
          Count: this.packages.length,
          BlockedCount: this.blockedPackages.length,
        });
        this.dispatchEvent(new CustomEvent("packages-updated", { bubbles: true, composed: true }));
      } else {
        const error = result.ok
          ? (result.value.RestoreError ?? result.value.RollbackError ?? result.value.Results.find((r) => !r.Success)?.Error)
          : result.error;
        this.statusText = result.ok && result.value.RolledBack
          ? `Update rolled back${error ? `: ${error}` : ""}`
          : `Failed to update ${pkg.Id}${error ? `: ${error}` : ""}`;
        return false;
      }

      return true;
    } finally {
      pkg.IsUpdating = false;
      this.requestUpdate();
    }
  }

  private async updatePackagesSequentiallyAsync(
    packages: OutdatedPackageViewModel[]
  ): Promise<void> {
    if (packages.length === 0 || this.isRefreshing) return;

    const updates = packages.map((pkg) => ({
      PackageId: pkg.Id,
      Version: pkg.LatestVersion,
      ProjectPaths: pkg.Projects.map((project) => project.Path),
      ...(pkg.CpmCondition ? { CpmCondition: pkg.CpmCondition } : {}),
      ...(pkg.CpmFramework ? { CpmTfm: pkg.CpmFramework } : {}),
      Scope: pkg.CpmCondition ? "group" as const : "unconditional" as const,
    }));

    this.isUpdating = true;
    packages.forEach((pkg) => { pkg.IsUpdating = true; });
    this.statusText = `Updating ${packages.length} package${packages.length !== 1 ? "s" : ""} transactionally...`;
    this.requestUpdate();
    try {
      const result = await hostApi.batchUpdatePackagesAsync({
        Updates: updates,
        Transactional: true,
        SkipRestore: false,
      });

      if (!result.ok) {
        this.statusText = `Update failed: ${result.error}`;
        return;
      }
      if (result.value.RolledBack) {
        const reason = result.value.RestoreError ?? result.value.RollbackError;
        this.statusText = `Update rolled back${reason ? `: ${reason}` : ""}`;
        await hostApi.updateBadgeAsync({
          Count: this.packages.length,
          BlockedCount: this.blockedPackages.length,
        });
        return;
      }

      // The transaction succeeded, so every selected row can be removed.
      this.packages = this.packages.filter((pkg) => !packages.includes(pkg));
      this.dispatchEvent(new CustomEvent<number>("count-changed", {
        detail: this.packages.length,
        bubbles: true,
        composed: true,
      }));
      this.statusText = `${packages.length} package${packages.length !== 1 ? "s" : ""} updated and restored`;
      await hostApi.updateBadgeAsync({
        Count: this.packages.length,
        BlockedCount: this.blockedPackages.length,
      });
      this.dispatchEvent(new CustomEvent("packages-updated", { bubbles: true, composed: true }));
    } finally {
      packages.forEach((pkg) => { pkg.IsUpdating = false; });
      this.isUpdating = false;
      this.requestUpdate();
    }
  }

  private toPackageViewModel(pkg: OutdatedPackageViewModel): PackageViewModel {
    const vm = new PackageViewModel({
      Id: pkg.Id,
      Name: pkg.Id,
      IconUrl: "",
      Authors: [],
      Description: "",
      LicenseUrl: "",
      ProjectUrl: "",
      TotalDownloads: 0,
      Verified: false,
      Version: pkg.LatestVersion,
      InstalledVersion: pkg.InstalledVersion,
      Versions: [],
      Tags: [],
      Registration: "",
    }, "Detailed");
    vm.CpmFramework = pkg.CpmFramework;
    return vm;
  }

  private renderPackageRow(pkg: OutdatedPackageViewModel): unknown {
    return html`
      <div class="outdated-row">
        ${pkg.IsUpdating
          ? html`<span class="spinner medium row-checkbox" role="status" aria-label="Updating ${pkg.Id}"></span>`
          : html`
              <input
                class="row-checkbox"
                type="checkbox"
                aria-label="Select ${pkg.Id} for update"
                .checked=${pkg.Selected}
                @change=${(e: Event) => {
                  pkg.Selected = (e.target as HTMLInputElement).checked;
                  this.requestUpdate();
                }}
              />
            `}
        <package-row
          .package=${this.toPackageViewModel(pkg)}
          .embedded=${true}
          .updateVersion=${pkg.LatestVersion}
          @click=${() => this.dispatchEvent(new CustomEvent("package-selected", {
            detail: { packageId: pkg.Id, sourceUrl: pkg.SourceUrl },
            bubbles: true,
            composed: true,
          }))}
        ></package-row>
        ${!pkg.CpmMatched
          ? html`<span class="codicon codicon-warning" title="This condition matches none of the project's target frameworks"></span>`
          : nothing}
        ${pkg.BlockedBy.length > 0
          ? html`<span
              class="codicon codicon-lock"
              title="Latest ${pkg.LatestOverallVersion} is blocked by ${pkg.blockedReason}. Suggested version stays at ${pkg.LatestVersion}."
            ></span>`
          : nothing}
        <div class="row-actions">
          ${pkg.LatestOverallVersion
            ? html`
                <button
                  class="icon-btn"
                  aria-label="Update ${pkg.Id} to latest overall ${pkg.LatestOverallVersion}"
                  title=${pkg.BlockedBy.length > 0
                    ? `Update ${pkg.Id} to ${pkg.LatestOverallVersion}, overriding ${pkg.blockedReason}. Restore may fail.`
                    : `Update ${pkg.Id} to latest overall ${pkg.LatestOverallVersion}`}
                  ?disabled=${this.isUpdating || this.isRefreshing || pkg.IsUpdating}
                  @click=${async () => await this.updateSingleAsync(pkg, false, pkg.LatestOverallVersion)}
                >
                  <span class="codicon codicon-arrow-up"></span>
                </button>
              `
            : nothing}
          <button class="icon-btn" aria-label="Update ${pkg.Id}" title="Update ${pkg.Id}" ?disabled=${this.isUpdating || this.isRefreshing || pkg.IsUpdating} @click=${async () => await this.updateSingleAsync(pkg)}>
            <span class="codicon codicon-arrow-circle-up"></span>
          </button>
        </div>
      </div>
    `;
  }

  override render(): unknown {
    const isLoading = this._loadTask.status === TaskStatus.PENDING;
    const hasError = this._loadTask.status === TaskStatus.ERROR;
    const visible = this.visiblePackages;
    const totalSelectedCount = visible.filter((p) => p.Selected).length;
    const allVisibleSelected = this.allVisibleSelected;
    const updateBtnLabel = allVisibleSelected
      ? `Update all (${totalSelectedCount})`
      : `Update selected (${totalSelectedCount})`;

    return html`
      <div class="updates-container" aria-busy=${isLoading}>
        <div class="list-header">
          <div>
            <div class="list-title">Updates</div>
            <div class="list-subtitle">
              ${visible.length} update${visible.length !== 1 ? "s" : ""} available
              ${this.statusText ? html` · ${this.statusText}` : nothing}
            </div>
          </div>
          <div class="list-actions">
            ${visible.length > 0
              ? html`
                  <button class="ghost-btn" title="${allVisibleSelected ? "Deselect all" : "Select all"}" @click=${() => this.toggleSelectAll()}>
                    ${allVisibleSelected ? "Deselect all" : "Select all"}
                  </button>
                  <button class="primary-btn" ?disabled=${this.isUpdating || this.isRefreshing || totalSelectedCount === 0} @click=${async () => await this.updateAllSelectedAsync()}>
                    ${updateBtnLabel}
                  </button>
                  ${this.hasMultipleTfmsSelected
                    ? html`
                        <button
                          class="secondary-btn"
                          ?disabled=${this.isUpdating || this.isRefreshing}
                          title="Update every selected package for all of its target frameworks"
                          @click=${async () => await this.updateAllTfmsAsync()}
                        >
                          Update all TFMs
                        </button>
                      `
                    : nothing}
                `
              : nothing}
          </div>
        </div>
        ${visible.length > 0
          ? html`<div class="info-banner">
              <span class="codicon codicon-info"></span>
              <span>Framework-aligned packages stay on the target framework's major line. Use the separate latest-overall action only when you intend to cross it.</span>
            </div>`
          : nothing}
        ${this.blockedPackages.length > 0
          ? html`<section class="conflicts" aria-label="Dependency conflicts">
              <div class="conflicts-header">
                <span class="codicon codicon-lock"></span>
                <span>Dependency conflicts (${this.blockedPackages.length})</span>
              </div>
              <ul class="conflicts-list">
                ${this.blockedPackages.map((blocked) => html`
                  <li class="conflict-row">
                    <span class="conflict-title">
                      <span class="conflict-id">${blocked.Id}</span>
                      <span class="conflict-version">
                        ${blocked.InstalledVersion} → ${blocked.BlockedVersion} blocked
                      </span>
                    </span>
                    <span class="conflict-reason">
                      blocked by ${blocked.BlockedBy.map((constraint) =>
                        `${constraint.PackageId} ${constraint.InstalledVersion} requires ${constraint.Range}`
                      ).join("; ")}
                    </span>
                  </li>
                `)}
              </ul>
            </section>`
          : nothing}

        ${isLoading
          ? html`
              <div class="loading" role="status" aria-label="Loading">
                <span class="spinner large"></span>
                <span>Checking for updates...</span>
              </div>
            `
          : nothing}
        ${!isLoading && this.packages.length === 0 && this.blockedPackages.length === 0 && !hasError
          ? html`
              <div class="empty">
                <span class="codicon codicon-check"></span>
                All packages are up to date
              </div>
            `
          : nothing}
        ${!isLoading && !hasError && this.packages.length > 0 && visible.length === 0
          ? html`
              <div class="empty">
                <span class="codicon codicon-search"></span>
                No matching updates
              </div>
            `
          : nothing}
        ${hasError
          ? html`
              <div class="error" role="alert">
                <span class="codicon codicon-error"></span>
                Failed to check for updates
              </div>
            `
          : nothing}
        ${!isLoading && visible.length > 0
          ? html`
              <div class="package-list" role="list" aria-label="Outdated packages">
                ${this.groupedVisiblePackages.map(
                  (group) => html`
                    <label class="group-header">
                      <input
                        type="checkbox"
                        class="group-select"
                        aria-label="Select all ${group.label} updates"
                        .checked=${group.packages.length > 0 && group.packages.every((pkg) => pkg.Selected)}
                        .indeterminate=${group.packages.some((pkg) => pkg.Selected) && !group.packages.every((pkg) => pkg.Selected)}
                        @change=${(e: Event) =>
                          this.toggleGroupSelection(
                            group.packages,
                            (e.target as HTMLInputElement).checked
                          )}
                      />
                      <span>${group.label}</span>
                      <span class="group-count">${group.packages.length}</span>
                    </label>
                    ${group.packages.map((pkg) => this.renderPackageRow(pkg))}
                  `
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
