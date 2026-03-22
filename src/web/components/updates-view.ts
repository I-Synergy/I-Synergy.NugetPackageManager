import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";

import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import { OutdatedPackageViewModel, PackageViewModel } from "../types";
import "./package-row";

@customElement("updates-view")
export class UpdatesView extends LitElement {
  static override styles = [
    codicon,
    scrollableBase,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex: 1;
        width: 100%;
      }

      .updates-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        overflow: hidden;

        .outdated-row {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 4px 0 2px;
          border-bottom: 1px solid var(--vscode-panelSection-border);

          .row-checkbox {
            flex-shrink: 0;
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
        }
      }
    `,
  ];

  @state() packages: OutdatedPackageViewModel[] = [];
  @state() isUpdating: boolean = false;
  @state() statusText: string = "";
  @property({ type: Boolean }) prerelease: boolean = false;
  @property({ attribute: false }) projectPaths: string[] = [];
  @property() sourceUrl: string = "";
  @property() filterQuery: string = "";

  private _loadTask = new Task(this, {
    task: async ([projectPaths, sourceUrl, prerelease, forceReload], { signal }) => {
      const req: Parameters<typeof hostApi.getOutdatedPackagesAsync>[0] = {
        Prerelease: prerelease,
      };
      if (projectPaths.length > 0) req.ProjectPaths = projectPaths;
      if (sourceUrl) req.SourceUrl = sourceUrl;
      if (forceReload) req.ForceReload = true;
      const result = await hostApi.getOutdatedPackagesAsync(req, signal);
      if (!result.ok) throw new Error("Failed to check for updates");
      return (result.value.Packages ?? []).map((p) => new OutdatedPackageViewModel(p));
    },
    args: () => [this.projectPaths, this.sourceUrl, this.prerelease, false] as [string[], string, boolean, boolean],
    onComplete: (packages) => {
      packages.forEach((p) => (p.Selected = true));
      this.packages = packages;
      this.statusText =
        packages.length > 0
          ? `${packages.length} update${packages.length !== 1 ? "s" : ""} available`
          : "";
      this.dispatchEvent(new CustomEvent<number>("count-changed", {
        detail: packages.length,
        bubbles: true,
        composed: true,
      }));
    },
  });

  private get visiblePackages(): OutdatedPackageViewModel[] {
    if (!this.filterQuery) return this.packages;
    const q = this.filterQuery.toLowerCase();
    return this.packages.filter((p) => p.Id.toLowerCase().includes(q));
  }

  private get allVisibleSelected(): boolean {
    const all = this.packages;
    return all.length > 0 && all.every((p) => p.Selected);
  }

  private toggleSelectAll(): void {
    const selectAll = !this.allVisibleSelected;
    this.packages.forEach((p) => { p.Selected = selectAll; });
    this.requestUpdate();
  }

  async LoadOutdatedPackagesAsync(forceReload: boolean = false): Promise<void> {
    this.packages = [];
    this.statusText = "";
    await this._loadTask.run([this.projectPaths, this.sourceUrl, this.prerelease, forceReload]);
  }

  private async updateSingleAsync(pkg: OutdatedPackageViewModel, skipRestore = false): Promise<void> {
    pkg.IsUpdating = true;
    this.requestUpdate();
    try {
      const result = await hostApi.batchUpdatePackagesAsync({
        SkipRestore: skipRestore,
        Updates: [
          {
            PackageId: pkg.Id,
            Version: pkg.LatestVersion,
            ProjectPaths: pkg.Projects.map((p) => p.Path),
          },
        ],
      });
      const succeeded = result.ok && result.value.Results.every((r) => r.Success);
      if (succeeded) {
        this.packages = this.packages.filter((p) => p.Id !== pkg.Id);
        this.dispatchEvent(new CustomEvent<number>("count-changed", {
          detail: this.packages.length,
          bubbles: true,
          composed: true,
        }));
        this.statusText =
          this.packages.length > 0
            ? `${this.packages.length} update${this.packages.length !== 1 ? "s" : ""} available`
            : "All packages are up to date";
      } else {
        const error = result.ok ? result.value.Results.find((r) => !r.Success)?.Error : result.error;
        this.statusText = `Failed to update ${pkg.Id}${error ? `: ${error}` : ""}`;
      }
    } finally {
      pkg.IsUpdating = false;
      this.requestUpdate();
    }
  }

  private async updateAllSelectedAsync(): Promise<void> {
    const selected = this.packages.filter((p) => p.Selected);
    if (selected.length === 0) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Update ${selected.length} package${selected.length !== 1 ? "s" : ""}?`,
      Detail: selected.map((p) => `${p.Id}: ${p.InstalledVersion} -> ${p.LatestVersion}`).join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    const projectPaths = [...new Set(selected.flatMap((p) => p.Projects.map((proj) => proj.Path)))];
    this.isUpdating = true;
    this.requestUpdate();
    try {
      // Update each package reference in parallel with restore skipped.
      // Each succeeds as soon as the version is written to the .csproj — the
      // package is removed from the list immediately, clearing progressively.
      await Promise.allSettled(selected.map((pkg) => this.updateSingleAsync(pkg, true)));
      // Run dotnet restore once for all affected projects after all writes are done.
      await hostApi.restoreProjectsAsync({ ProjectPaths: projectPaths });
    } finally {
      this.isUpdating = false;
      this.requestUpdate();
    }
  }

  private toPackageViewModel(pkg: OutdatedPackageViewModel): PackageViewModel {
    return new PackageViewModel({
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
          .updateVersion=${pkg.LatestVersion}
          @click=${() => this.dispatchEvent(new CustomEvent("package-selected", {
            detail: { packageId: pkg.Id, sourceUrl: pkg.SourceUrl },
            bubbles: true,
            composed: true,
          }))}
        ></package-row>
        <div class="row-actions">
          <button class="icon-btn" aria-label="Update ${pkg.Id}" title="Update ${pkg.Id}" ?disabled=${pkg.IsUpdating} @click=${async () => await this.updateSingleAsync(pkg)}>
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
    const totalSelectedCount = this.packages.filter((p) => p.Selected).length;
    const allPackagesSelected =
      this.packages.length > 0 && this.packages.every((p) => p.Selected);
    const updateBtnLabel = allPackagesSelected ? "Update All" : "Update Selected";

    return html`
      <div class="updates-container" aria-busy=${isLoading}>
        <div class="toolbar">
          <span class="status-text" role="status" aria-live="polite">${this.statusText}</span>
          <div class="toolbar-right">
            ${visible.length > 0
              ? html`
                  <button class="icon-btn" title="${allPackagesSelected ? "Deselect all" : "Select all"}" aria-label="${allPackagesSelected ? "Deselect all" : "Select all"}" @click=${() => this.toggleSelectAll()}>
                    <span class="codicon ${allPackagesSelected ? "codicon-check-all" : "codicon-circle-large-outline"}"></span>
                  </button>
                  <button class="primary-btn" ?disabled=${this.isUpdating || totalSelectedCount === 0} @click=${async () => await this.updateAllSelectedAsync()}>
                    ${updateBtnLabel}
                  </button>
                `
              : nothing}
          </div>
        </div>

        ${isLoading
          ? html`
              <div class="loading" role="status" aria-label="Loading">
                <span class="spinner large"></span>
                <span>Checking for updates...</span>
              </div>
            `
          : nothing}
        ${!isLoading && this.packages.length === 0 && !hasError
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
                ${visible.map((pkg) => this.renderPackageRow(pkg))}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
