import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";

import codicon from "@/web/styles/codicon.css";
import type { DropdownOption } from "./dropdown";
import "./dropdown";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import { InconsistentPackageViewModel } from "../types";

@customElement("consolidate-view")
export class ConsolidateView extends LitElement {
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

      .consolidate-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        overflow: hidden;

        .inconsistent-row {
          padding: 6px;
          border-bottom: 1px solid var(--vscode-panelSection-border);

          &.consolidating {
            opacity: 0.6;
          }

          .row-header {
            display: flex;
            align-items: center;
            gap: 8px;

            .package-name {
              font-weight: bold;
              font-size: 13px;
              flex: 1;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              cursor: pointer;
            }

            .package-name:hover {
              text-decoration: underline;
            }

            .cpm-badge {
              font-size: 10px;
              padding: 1px 4px;
              border-radius: 3px;
              background-color: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground);
            }

            .row-actions {
              display: flex;
              align-items: center;
              gap: 4px;

              .version-dropdown {
                min-width: 100px;
              }
            }
          }

          .version-details {
            margin-top: 4px;
            padding-left: 4px;

            .version-row {
              display: flex;
              gap: 8px;
              font-size: 11px;
              padding: 2px 0;

              .version {
                min-width: 60px;
                color: var(--vscode-charts-yellow);
                font-family: var(--vscode-editor-font-family);
              }

              .projects {
                color: var(--vscode-descriptionForeground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              }
            }
          }
        }
      }
    `,
  ];

  @state() packages: InconsistentPackageViewModel[] = [];
  @state() isConsolidating: boolean = false;
  @state() statusText: string = "";
  @property() selectedFramework: string = "";
  @property({ attribute: false }) projectPaths: string[] = [];

  private _loadTask = new Task(this, {
    task: async ([projectPaths, forceReload], { signal }) => {
      const req: Parameters<typeof hostApi.getInconsistentPackagesAsync>[0] = {};
      if (projectPaths.length > 0) req.ProjectPaths = projectPaths;
      if (forceReload) req.ForceReload = true;
      const result = await hostApi.getInconsistentPackagesAsync(req, signal);
      if (!result.ok) throw new Error("Failed to check for inconsistencies");
      return (result.value.Packages ?? []).map((p) => new InconsistentPackageViewModel(p));
    },
    args: () => [this.projectPaths, false] as [string[], boolean],
    onComplete: (packages) => {
      this.packages = packages;
      this.statusText =
        packages.length > 0
          ? `${packages.length} package${packages.length !== 1 ? "s" : ""} with inconsistent versions`
          : "";
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
    },
  });

  get frameworkOptions(): Array<{ value: string; label: string }> {
    const frameworks = new Set(
      this.packages.flatMap((p) => p.Versions.map((v) => v.CpmFramework)).filter(Boolean)
    );
    if (frameworks.size === 0) return [];
    return [
      { value: "", label: "All frameworks" },
      ...[...frameworks].sort().map((f) => ({ value: f, label: f })),
    ];
  }

  private get visiblePackages(): InconsistentPackageViewModel[] {
    if (this.selectedFramework === "" || this.frameworkOptions.length === 0) return this.packages;
    return this.packages.filter((p) =>
      p.Versions.some((v) => v.CpmFramework === this.selectedFramework || v.CpmFramework === "")
    );
  }

  async LoadInconsistentPackagesAsync(forceReload: boolean = false): Promise<void> {
    this.packages = [];
    this.statusText = "";
    try {
      await this._loadTask.run([this.projectPaths, forceReload]);
    } catch (err) {
      // Avoid unhandled promise rejections; rely on TaskStatus.ERROR for rendering.
      console.error(err);
    }
  }

  private selectPackage(packageId: string): void {
    this.dispatchEvent(new CustomEvent("package-selected", {
      detail: { packageId },
      bubbles: true,
      composed: true,
    }));
  }

  private async consolidateSingleAsync(pkg: InconsistentPackageViewModel): Promise<void> {
    pkg.IsConsolidating = true;
    this.requestUpdate();
    try {
      const allProjects = pkg.Versions.flatMap((v) => v.Projects.map((p) => p.Path));

      await hostApi.consolidatePackagesAsync({
        PackageId: pkg.Id,
        TargetVersion: pkg.TargetVersion,
        ProjectPaths: allProjects,
      });

      this.packages = this.packages.filter((p) => p.Id !== pkg.Id);
      this.dispatchEvent(new CustomEvent<number>("count-changed", {
        detail: this.packages.length,
        bubbles: true,
        composed: true,
      }));
      this.statusText =
        this.packages.length > 0
          ? `${this.packages.length} package${this.packages.length !== 1 ? "s" : ""} with inconsistent versions`
          : "All versions are consistent";
    } finally {
      pkg.IsConsolidating = false;
      this.requestUpdate();
    }
  }

  private async consolidateAllAsync(): Promise<void> {
    const confirm = await hostApi.showConfirmationAsync({
      Message: `Consolidate ${this.packages.length} package${this.packages.length !== 1 ? "s" : ""}?`,
      Detail: "This will update all inconsistent packages to their target versions.",
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.isConsolidating = true;
    try {
      const results = await Promise.allSettled(this.packages.map((pkg) => this.consolidateSingleAsync(pkg)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length > 0) {
        this.statusText = `${failed.length} package${failed.length !== 1 ? "s" : ""} failed to consolidate`;
      }
    } finally {
      this.isConsolidating = false;
      await this.LoadInconsistentPackagesAsync();
    }
  }

  private renderPackageRow(pkg: InconsistentPackageViewModel): unknown {
    return html`
      <div class="inconsistent-row ${pkg.IsConsolidating ? "consolidating" : ""}">
        <div class="row-header">
          <span class="package-name" @click=${() => this.selectPackage(pkg.Id)}>${pkg.Id}</span>
          ${pkg.CpmManaged ? html`<span class="cpm-badge">CPM Override</span>` : nothing}
          <div class="row-actions">
            ${pkg.IsConsolidating
              ? html`<span class="spinner medium"></span>`
              : html`
                  <custom-dropdown
                    class="version-dropdown"
                    ariaLabel="Target version for ${pkg.Id}"
                    .options=${pkg.Versions.map((v): DropdownOption => ({ value: v.Version, label: v.Version }))}
                    .value=${pkg.TargetVersion}
                    @change=${(e: CustomEvent<string>) => {
                      pkg.TargetVersion = e.detail;
                      this.requestUpdate();
                    }}
                  ></custom-dropdown>
                  <button class="icon-btn" aria-label="Consolidate ${pkg.Id}" title="Consolidate ${pkg.Id}" @click=${async () => await this.consolidateSingleAsync(pkg)}>
                    <span class="codicon codicon-arrow-circle-up"></span>
                  </button>
                `}
          </div>
        </div>
        <div class="version-details">
          ${pkg.Versions.map(
            (v) => html`
              <div class="version-row">
                <span class="version">${v.Version}</span>
                ${v.CpmFramework && !this.selectedFramework ? html`<span class="framework-badge">${v.CpmFramework}</span>` : nothing}
                <span class="projects">${v.Projects.map((p) => p.Name).join(", ")}</span>
              </div>
            `
          )}
        </div>
      </div>
    `;
  }

  override render(): unknown {
    const isLoading = this._loadTask.status === TaskStatus.PENDING;
    const hasError = this._loadTask.status === TaskStatus.ERROR;
    const visible = this.visiblePackages;

    return html`
      <div class="consolidate-container" aria-busy=${isLoading}>
        <div class="toolbar">
          <span class="status-text" role="status" aria-live="polite">${this.statusText}</span>
          <div class="toolbar-right">
            ${this.packages.length > 0
              ? html`
                  <button
                    class="primary-btn"
                    ?disabled=${this.isConsolidating}
                    @click=${async () => await this.consolidateAllAsync()}
                  >
                    Consolidate All
                  </button>
                `
              : nothing}
          </div>
        </div>

        ${isLoading
          ? html`
              <div class="loading" role="status" aria-label="Loading">
                <span class="spinner large"></span>
                <span>Checking for inconsistencies...</span>
              </div>
            `
          : nothing}
        ${!isLoading && visible.length === 0 && !hasError
          ? html`
              <div class="empty">
                <span class="codicon codicon-check"></span>
                All package versions are consistent
              </div>
            `
          : nothing}
        ${hasError
          ? html`
              <div class="error" role="alert">
                <span class="codicon codicon-error"></span>
                Failed to check for inconsistencies
              </div>
            `
          : nothing}
        ${!isLoading && visible.length > 0
          ? html`
              <div class="package-list" role="list" aria-label="Inconsistent packages">
                ${visible.map((pkg) => this.renderPackageRow(pkg))}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
