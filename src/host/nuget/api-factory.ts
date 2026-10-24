import * as vscode from "vscode";
import NuGetApi from "../nuget/api";
import NuGetConfigResolver from "../utilities/nuget-config-resolver";
import PasswordScriptExecutor from "../utilities/password-script-executor";
import { Logger } from "../../common/logger";

class NuGetApiFactory {
  private readonly _sourceApiCollection = new Map<string, NuGetApi>();

  public async GetSourceApiAsync(url: string): Promise<NuGetApi> {
    const cached = this._sourceApiCollection.get(url);
    if (cached) {
      Logger.debug(`NuGetApiFactory.GetSourceApiAsync: Returning cached API instance for ${url}`);
      return cached;
    }

    Logger.debug(`NuGetApiFactory.GetSourceApiAsync: Creating new API instance for ${url}`);
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

    Logger.debug(`NuGetApiFactory.GetSourceApiAsync: Available sources: ${sources.map(s => `${s.Name}=${s.Url} (hasAuth=${!!s.Username || !!s.Password})`).join(", ")}`);

    // Match by URL with/without trailing slash normalization
    const normalizeUrl = (u: string) => u.replace(/\/+$/, "").toLowerCase();
    const sourceWithCreds = sources.find(s => normalizeUrl(s.Url) === normalizeUrl(url));

    const hasAuth = !!(sourceWithCreds?.Username || sourceWithCreds?.Password);
    if (hasAuth) {
      Logger.info(`NuGetApiFactory.GetSourceApiAsync: Using credentials for ${url} (user: ${sourceWithCreds?.Username})`);
    } else {
      Logger.warn(`NuGetApiFactory.GetSourceApiAsync: No credentials found for ${url}. Available source URLs: [${sources.map(s => s.Url).join(", ")}]`);
    }

    const api = new NuGetApi(url, sourceWithCreds?.Username, sourceWithCreds?.Password);
    this._sourceApiCollection.set(url, api);
    return api;
  }

  public ClearCache() {
    for (const api of this._sourceApiCollection.values()) {
      api.ClearPackageCache();
    }
    this._sourceApiCollection.clear();
    PasswordScriptExecutor.ClearCache();
  }
}

export default new NuGetApiFactory();
