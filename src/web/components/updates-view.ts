import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

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
  @state() isLoading: boolean = false;
  @state() isUpdating: boolean = false;
  @state() hasError: boolean = false;
  @property({ type: Boolean }) prerelease: boolean = false;
  @state() statusText: string = "";
  @state() loadingText: string = "Checking for updates...";
  @property({ attribute: false }) projectPaths: string[] = [];
  @property() sourceUrl: string = "";
  @property() filterQuery: string = "";

  private loaded = false;
  private _loadAc: AbortController | null = null;

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

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.loaded) {
      this.loaded = true;
      this.LoadOutdatedPackages();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._loadAc?.abort();
  }

  async LoadOutdatedPackages(forceReload: boolean = false): Promise<void> {
    this._loadAc?.abort();
    const ac = new AbortController();
    this._loadAc = ac;

    this.isLoading = true;
    this.hasError = false;
    this.packages = [];
    this.loadingText = "Checking for updates...";

    try {
      const req: Parameters<typeof hostApi.getOutdatedPackages>[0] = {
        Prerelease: this.prerelease,
      };
      if (this.projectPaths.length > 0) req.ProjectPaths = this.projectPaths;
      if (this.sourceUrl) req.SourceUrl = this.sourceUrl;
      if (forceReload) req.ForceReload = true;
      const result = await hostApi.getOutdatedPackages(req, ac.signal);

      if (ac.signal.aborted) return;

      if (!result.ok) {
        this.hasError = true;
        this.statusText = "Failed to check for updates";
      } else {
        this.packages = (result.value.Packages ?? []).map(
          (p) => new OutdatedPackageViewModel(p)
        );
        this.packages.forEach((p) => (p.Selected = true));
        this.dispatchEvent(new CustomEvent<number>("count-changed", {
          detail: this.packages.length,
          bubbles: true,
          composed: true,
        }));
        this.statusText =
          this.packages.length > 0
            ? `${this.packages.length} update${this.packages.length !== 1 ? "s" : ""} available`
            : "";
      }
    } catch {
      if (ac.signal.aborted) return;
      this.hasError = true;
    } finally {
      if (!ac.signal.aborted) this.isLoading = false;
    }
  }

  private async updateSingle(pkg: OutdatedPackageViewModel): Promise<void> {
    pkg.IsUpdating = true;
    this.requestUpdate();
    try {
      const result = await hostApi.batchUpdatePackages({
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

  private async updateAllSelected(): Promise<void> {
    const selected = this.packages.filter((p) => p.Selected);
    if (selected.length === 0) return;

    const confirm = await hostApi.showConfirmation({
      Message: `Update ${selected.length} package${selected.length !== 1 ? "s" : ""}?`,
      Detail: selected.map((p) => `${p.Id}: ${p.InstalledVersion} -> ${p.LatestVersion}`).join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.isUpdating = true;
    selected.forEach((p) => { p.IsUpdating = true; });
    this.requestUpdate();
    try {
      await hostApi.batchUpdatePackages({
        Updates: selected.map((p) => ({
          PackageId: p.Id,
          Version: p.LatestVersion,
          ProjectPaths: p.Projects.map((proj) => proj.Path),
        })),
      });
      await this.LoadOutdatedPackages();
    } finally {
      this.isUpdating = false;
      selected.forEach((p) => { p.IsUpdating = false; });
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
          <button class="icon-btn" aria-label="Update ${pkg.Id}" title="Update ${pkg.Id}" ?disabled=${pkg.IsUpdating} @click=${() => this.updateSingle(pkg)}>
            <span class="codicon codicon-arrow-circle-up"></span>
          </button>
        </div>
      </div>
    `;
  }

  override render(): unknown {
    const visible = this.visiblePackages;
    const totalSelectedCount = this.packages.filter((p) => p.Selected).length;
    const allPackagesSelected =
      this.packages.length > 0 && this.packages.every((p) => p.Selected);
    const updateBtnLabel = allPackagesSelected ? "Update All" : "Update Selected";

    return html`
      <div class="updates-container" aria-busy=${this.isLoading}>
        <div class="toolbar">
          <span class="status-text" role="status" aria-live="polite">${this.statusText}</span>
          <div class="toolbar-right">
            ${visible.length > 0
              ? html`
                  <button class="icon-btn" title="${allPackagesSelected ? "Deselect all" : "Select all"}" aria-label="${allPackagesSelected ? "Deselect all" : "Select all"}" @click=${() => this.toggleSelectAll()}>
                    <span class="codicon ${allPackagesSelected ? "codicon-check-all" : "codicon-circle-large-outline"}"></span>
                  </button>
                  <button class="primary-btn" ?disabled=${this.isUpdating || totalSelectedCount === 0} @click=${() => this.updateAllSelected()}>
                    ${updateBtnLabel}
                  </button>
                `
              : nothing}
          </div>
        </div>

        ${this.isLoading
          ? html`
              <div class="loading" role="status" aria-label="Loading">
                <span class="spinner large"></span>
                <span>${this.loadingText}</span>
              </div>
            `
          : nothing}
        ${!this.isLoading && this.packages.length === 0 && !this.hasError
          ? html`
              <div class="empty">
                <span class="codicon codicon-check"></span>
                All packages are up to date
              </div>
            `
          : nothing}
        ${!this.isLoading && !this.hasError && this.packages.length > 0 && visible.length === 0
          ? html`
              <div class="empty">
                <span class="codicon codicon-search"></span>
                No matching updates
              </div>
            `
          : nothing}
        ${this.hasError
          ? html`
              <div class="error" role="alert">
                <span class="codicon codicon-error"></span>
                Failed to check for updates
              </div>
            `
          : nothing}
        ${!this.isLoading && visible.length > 0
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
