import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import codicon from "@/web/styles/codicon.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "../registrations";
import { ProjectPackageViewModel, ProjectViewModel } from "../types";
import type { UpdateProjectRequest } from "@/common/rpc/types";

const styles = css`
  .project-row {
    margin: 2px;
    padding: 3px;
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: space-between;
    cursor: default;

    &:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .project-title {
      overflow: hidden;
      text-overflow: ellipsis;
      .name {
        font-weight: bold;
      }
    }

    .project-actions {
      display: flex;
      gap: 3px;
      align-items: center;

      .spinner {
        margin: 3px;
      }
    }
  }

  .progress-container {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 120px;
    max-width: 180px;

    .progress-stage {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .progress-track {
      height: 4px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      border-radius: 2px;
      overflow: hidden;

      .progress-fill {
        height: 100%;
        background: var(--vscode-progressBar-background);
        opacity: 1;
        border-radius: 2px;
        transition: width 0.3s ease;
      }
    }
  }
`;

type ProgressState = {
  stage: string;
  percent: number;
};

@customElement("project-row")
export class ProjectRow extends LitElement {
  static styles = [codicon, sharedStyles, styles];

  @property({ type: Object }) project!: ProjectViewModel;
  @property() packageId!: string;
  @property() packageVersion!: string;
  @property() sourceUrl!: string;
  @state() private loaders = new Map<string, boolean>();
  @state() private progress: ProgressState | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  get projectPackage() {
    return this.project.Packages.find((x) => x.Id === this.packageId);
  }

  private startPolling(operationId: string): void {
    this.pollTimer = setInterval(() => {
      void hostApi.getOperationProgress({ OperationId: operationId }).then((result) => {
        if (result.ok && result.value.Active) {
          this.progress = { stage: result.value.Stage, percent: result.value.Percent };
        }
      });
    }, 300);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.progress = null;
  }

  private async update_(type: "INSTALL" | "UNINSTALL" | "UPDATE"): Promise<void> {
    if (this.loaders.get(this.packageId) === true) return;

    if (type === "UNINSTALL") {
      const confirm = await hostApi.showConfirmation({
        Message: `Uninstall ${this.packageId}?`,
        Detail: `This will remove ${this.packageId} from ${this.project.Name}.`,
      });
      if (!confirm.ok || !confirm.value.Confirmed) return;
    }

    const operationId = `${type.toLowerCase()}-${this.packageId}-${Date.now()}`;

    const request: UpdateProjectRequest = {
      Type: type,
      ProjectPath: this.project.Path,
      PackageId: this.packageId,
      Version: this.packageVersion,
      SourceUrl: this.sourceUrl,
      OperationId: operationId,
    };

    this.loaders.set(request.PackageId, true);
    this.progress = { stage: "Starting...", percent: 5 };
    this.requestUpdate();
    this.startPolling(operationId);

    const result = await hostApi.updateProject(request);
    this.stopPolling();

    if (result.ok) {
      this.project.Packages = result.value.Project.Packages.map(
        (x) => new ProjectPackageViewModel(x)
      );
      this.dispatchEvent(
        new CustomEvent("project-updated", {
          detail: { isCpmEnabled: result.value.IsCpmEnabled },
          bubbles: true,
          composed: true,
        })
      );
    }

    this.loaders.delete(request.PackageId);
    this.requestUpdate();
  }

  private renderProgress() {
    const p = this.progress;
    if (!p) return html`<span class="spinner medium" role="status" aria-label="Loading"></span>`;
    return html`
      <div class="progress-container">
        <span class="progress-stage">${p.stage}</span>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${p.percent}%"></div>
        </div>
      </div>
    `;
  }

  private renderActions() {
    if (this.loaders.get(this.packageId) === true) {
      return this.renderProgress();
    }

    const pkg = this.projectPackage;
    const version = pkg?.Version;

    if (pkg === undefined) {
      return html`
        <button class="icon-btn" aria-label="Install package" title="Install" @click=${() => this.update_("INSTALL")}>
          <span class="codicon codicon-diff-added"></span>
        </button>
      `;
    }

    const showUpdate =
      version !== this.packageVersion &&
      version !== undefined &&
      !pkg.IsPinned;

    return html`
      <span class="version">${version}</span>
      ${showUpdate
        ? html`
            <button class="icon-btn" aria-label="Update package" title="Update" @click=${() => this.update_("UPDATE")}>
              <span class="codicon codicon-arrow-circle-up"></span>
            </button>
          `
        : nothing}
      <button class="icon-btn" aria-label="Uninstall package" title="Uninstall" @click=${() => this.update_("UNINSTALL")}>
        <span class="codicon codicon-diff-removed"></span>
      </button>
    `;
  }

  render() {
    return html`
      <div class="project-row">
        <div class="project-title">
          <span class="name">${this.project.Name}</span>
        </div>
        <div class="project-actions">${this.renderActions()}</div>
      </div>
    `;
  }
}
