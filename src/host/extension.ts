import * as vscode from "vscode";
import nonce from "@/common/nonce";
import { RpcHost } from "@/common/rpc/rpc-host";
import { createHostAPI } from "./host-api";
import { Logger } from "../common/logger";
import { PackageVersionDecorator } from "./utilities/package-version-decorator";
import nugetApiFactory from "./nuget/api-factory";
import NuGetConfigResolver from "./utilities/nuget-config-resolver";

export function activate(context: vscode.ExtensionContext) {
  Logger.configure(context);
  Logger.info("Extension.activate: Extension activated");

  // One-time cleanup: remove legacy workspace-level settings that were previously
  // incorrectly written at the workspace scope instead of global scope.
  void (async () => {
    try {
      const config = vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager");
      await config.update("sources", undefined, vscode.ConfigurationTarget.Workspace);
      await config.update("skipRestore", undefined, vscode.ConfigurationTarget.Workspace);
    } catch { /* no workspace folder or settings don't exist — safe to ignore */ }
  })();

  const provider = new NugetViewProvider(context.extensionUri);

  context.subscriptions.push(new PackageVersionDecorator());

  const previousVersion: string | undefined = context.globalState.get("i-synergy-nugetpackagemanager.version");
  context.globalState.update("i-synergy-nugetpackagemanager.version", context.extension.packageJSON.version);
  if (previousVersion == undefined) {
    Logger.info("Extension.activate: Extension installed");
  } else if (previousVersion != context.extension.packageJSON.version)
    Logger.info("Extension.activate: Extension upgraded from version %s", previousVersion);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("i-synergy-nugetpackagemanager.packageView", provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nugetpackage.open", () => {
      vscode.commands.executeCommand("i-synergy-nugetpackagemanager.packageView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nugetpackage.install", async () => {
      const packageId = await vscode.window.showInputBox({
        prompt: "Enter the NuGet package ID to install",
        placeHolder: "e.g. Newtonsoft.Json",
      });
      if (!packageId) return;
      vscode.commands.executeCommand("i-synergy-nugetpackagemanager.packageView.focus");
      provider.sendSearchQuery(packageId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nugetpackage.update", () => {
      vscode.commands.executeCommand("i-synergy-nugetpackagemanager.packageView.focus");
      provider.sendNavigateToTab("updates");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nugetpackage.remove", () => {
      vscode.commands.executeCommand("i-synergy-nugetpackagemanager.packageView.focus");
      provider.sendNavigateToTab("installed");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nugetpackage.reportProblem", async () => {
      vscode.env.openExternal(
        vscode.Uri.parse("https://github.com/I-Synergy/I-Synergy.NugetPackageManager/issues/new")
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nugetpackage.openSettings", () => {
      provider.sendNavigateToRoute("SETTINGS");
    })
  );

  const nugetConfigWatcher = vscode.workspace.createFileSystemWatcher(
    "**/{nuget.config,NuGet.Config,NuGet.config}"
  );
  let nugetConfigChangeTimeout: NodeJS.Timeout | undefined;
  const onNugetConfigChanged = () => {
    if (nugetConfigChangeTimeout) {
      clearTimeout(nugetConfigChangeTimeout);
    }
    nugetConfigChangeTimeout = setTimeout(() => {
      provider.sendReloadConfiguration();
    }, 200);
  };
  nugetConfigWatcher.onDidChange(onNugetConfigChanged);
  nugetConfigWatcher.onDidCreate(onNugetConfigChanged);
  nugetConfigWatcher.onDidDelete(onNugetConfigChanged);
  context.subscriptions.push(nugetConfigWatcher);
}

class NugetViewProvider implements vscode.WebviewViewProvider {
  private rpcHost: RpcHost | undefined;
  private webviewView: vscode.WebviewView | undefined;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  sendSearchQuery(query: string): void {
    this.webviewView?.webview.postMessage({
      type: "command",
      command: "search",
      query,
    });
  }

  sendNavigateToTab(tab: string): void {
    this.webviewView?.webview.postMessage({
      type: "command",
      command: "navigate-tab",
      tab,
    });
  }

  sendNavigateToRoute(route: string): void {
    this.webviewView?.webview.postMessage({
      type: "command",
      command: "navigate-route",
      route,
    });
  }

  sendReloadConfiguration(): void {
    this.webviewView?.webview.postMessage({
      type: "command",
      command: "reload-configuration",
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    Logger.debug("NugetViewProvider.resolveWebviewView: Resolving webview view");

    this.webviewView = webviewView;

    // Dispose previous RPC host if webview is re-resolved
    this.rpcHost?.dispose();

    // Clear all source-related caches on startup so sources and credentials are
    // always resolved fresh from nuget.config and password scripts.
    nugetApiFactory.ClearCache();
    NuGetConfigResolver.ClearCache();

    const api = createHostAPI();
    this.rpcHost = new RpcHost(webviewView.webview, api);

    const webJsSrc = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, ...["dist", "web.js"])
    );
    const webCssSrc = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, ...["dist", "web.css"])
    );

    const nonceValue = nonce();
    webviewView.webview.html = /*html*/ `
	  <!DOCTYPE html>
	  <html lang="en">
		<head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonceValue}';">
      <link rel="stylesheet" type="text/css" href="${webCssSrc}"/>
		  <title>NuGet Package Manager</title>
		</head>
		<body>
		  <i-synergy-nugetpackagemanager></i-synergy-nugetpackagemanager>
		  <script type="module" nonce="${nonceValue}" src="${webJsSrc}"></script>
		</body>
	  </html>
	`;
    webviewView.webview.options = {
      enableScripts: true,
    };
  }
}

// This method is called when your extension is deactivated
export function deactivate() {
  Logger.info("Extension.deactivate: Extension deactivated");
}
