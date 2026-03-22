import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";

import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import { VulnerablePackageViewModel } from "../types";

const severityColors: Record<number, string> = {
  3: "var(--vscode-charts-red, #f14c4c)",
  2: "var(--vscode-charts-orange, #cca700)",
  1: "var(--vscode-charts-yellow, #cca700)",
  0: "var(--vscode-descriptionForeground)",
};

@customElement("vulnerabilities-view")
export class VulnerabilitiesView extends LitElement {
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

      .vuln-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        overflow: hidden;

        .vuln-row {
          padding: 6px;
          border-bottom: 1px solid var(--vscode-panelSection-border);

          .row-header {
            display: flex;
            align-items: center;
            gap: 8px;

            .severity-badge {
              font-size: 10px;
              font-weight: bold;
              padding: 1px 6px;
              border-radius: 3px;
              text-transform: uppercase;
              white-space: nowrap;
            }

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

            .advisory-link {
              font-size: 11px;
              color: var(--vscode-textLink-foreground);
              cursor: pointer;
              text-decoration: none;
              white-space: nowrap;
            }

            .advisory-link:hover {
              text-decoration: underline;
            }
          }

          .vuln-details {
            margin-top: 4px;
            padding-left: 4px;
            font-size: 11px;

            .detail-row {
              display: flex;
              gap: 8px;
              padding: 1px 0;

              .label {
                color: var(--vscode-descriptionForeground);
                min-width: 100px;
              }

              .value {
                font-family: var(--vscode-editor-font-family);
              }
            }

            .project-list {
              color: var(--vscode-descriptionForeground);
              margin-top: 2px;
            }
          }
        }
      }
    `,
  ];

  @state() packages: VulnerablePackageViewModel[] = [];
  @state() statusText: string = "";
  @property({ attribute: false }) projectPaths: string[] = [];

  private _loadTask = new Task(this, {
    task: async ([projectPaths, forceReload], { signal }) => {
      const req: Parameters<typeof hostApi.getVulnerablePackagesAsync>[0] = {};
      if (projectPaths.length > 0) req.ProjectPaths = projectPaths;
      if (forceReload) req.ForceReload = true;
      const result = await hostApi.getVulnerablePackagesAsync(req, signal);
      if (!result.ok) throw new Error("Failed to scan for vulnerabilities");
      return (result.value.Packages ?? []).map((p) => new VulnerablePackageViewModel(p));
    },
    args: () => [this.projectPaths, false] as [string[], boolean],
    onComplete: (packages) => {
      this.packages = packages;
      this.statusText =
        packages.length > 0
          ? `${packages.length} vulnerabilit${packages.length !== 1 ? "ies" : "y"} found`
          : "";
      this.dispatchEvent(new CustomEvent<number>("count-changed", {
        detail: packages.length,
        bubbles: true,
        composed: true,
      }));
    },
  });

  async LoadVulnerablePackagesAsync(forceReload: boolean = false): Promise<void> {
    this.packages = [];
    this.statusText = "";
    await this._loadTask.run([this.projectPaths, forceReload]);
  }

  private getSeverityColor(severity: number): string {
    return severityColors[severity] ?? severityColors[0] ?? "var(--vscode-descriptionForeground)";
  }

  private selectPackage(packageId: string): void {
    this.dispatchEvent(new CustomEvent("package-selected", {
      detail: { packageId },
      bubbles: true,
      composed: true,
    }));
  }

  private openAdvisory(url: string): void {
    hostApi.openUrlAsync({ Url: url });
  }

  private renderPackageRow(pkg: VulnerablePackageViewModel): unknown {
    const color = this.getSeverityColor(pkg.Severity);
    return html`
      <div class="vuln-row">
        <div class="row-header">
          <span
            class="severity-badge"
            role="img"
            aria-label="${pkg.SeverityLabel} severity"
            style="background-color: ${color}; color: var(--vscode-editor-background);"
          >
            ${pkg.SeverityLabel}
          </span>
          <span class="package-name" @click=${() => this.selectPackage(pkg.Id)}>${pkg.Id}</span>
          <a
            class="advisory-link"
            href=${pkg.AdvisoryUrl}
            role="link"
            tabindex="0"
            aria-label="View advisory for ${pkg.Id}"
            @click=${(e: Event) => { e.preventDefault(); this.openAdvisory(pkg.AdvisoryUrl); }}
          >
            <span class="codicon codicon-link-external"></span> Advisory
          </a>
        </div>
        <div class="vuln-details">
          <div class="detail-row">
            <span class="label">Installed:</span>
            <span class="value">${pkg.InstalledVersion}</span>
          </div>
          <div class="detail-row">
            <span class="label">Affected:</span>
            <span class="value">${pkg.AffectedVersionRange}</span>
          </div>
          <div class="project-list">
            ${pkg.Projects.map((p) => p.Name).join(", ")}
          </div>
        </div>
      </div>
    `;
  }

  override render(): unknown {
    const isLoading = this._loadTask.status === TaskStatus.PENDING;
    const hasError = this._loadTask.status === TaskStatus.ERROR;

    return html`
      <div class="vuln-container" aria-busy=${isLoading}>
        <div class="toolbar">
          <span class="status-text" role="status" aria-live="polite">${this.statusText}</span>
        </div>

        ${isLoading
          ? html`
              <div class="loading" role="status" aria-label="Loading">
                <span class="spinner large"></span>
                <span>Scanning for vulnerabilities...</span>
              </div>
            `
          : nothing}
        ${!isLoading && this.packages.length === 0 && !hasError
          ? html`
              <div class="empty">
                <span class="codicon codicon-shield"></span>
                No known vulnerabilities found
              </div>
            `
          : nothing}
        ${hasError
          ? html`
              <div class="error" role="alert">
                <span class="codicon codicon-error"></span>
                Failed to scan for vulnerabilities
              </div>
            `
          : nothing}
        ${!isLoading && this.packages.length > 0
          ? html`
              <div class="package-list" role="list" aria-label="Vulnerable packages">
                ${this.packages.map((pkg) => this.renderPackageRow(pkg))}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
