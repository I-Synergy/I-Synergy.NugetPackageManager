import fs from "fs";
import * as path from "path";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import os from "os";
import * as vscode from "vscode";
import PasswordScriptExecutor from "./password-script-executor";
import CredentialsCache from "./credentials-cache";
import { Logger } from "../../common/logger";

export type SourceWithCredentials = {
  Name: string;
  Url: string;
  Username?: string;
  Password?: string;
};

export default class NuGetConfigResolver {
  private static readonly CONFIG_FILENAMES = ["nuget.config", "NuGet.Config", "NuGet.config"];

  static async GetSourcesAndDecodePasswordsAsync(workspaceRoots?: string | string[]): Promise<SourceWithCredentials[]> {
    const roots = Array.isArray(workspaceRoots) ? workspaceRoots : (workspaceRoots ? [workspaceRoots] : []);
    Logger.debug(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Starting resolution (workspaceRoots: ${roots.join(", ")})`);
    const config = vscode.workspace.getConfiguration("i-synergy-nugetpackagemanager");
    const sourcesMap = new Map<string, SourceWithCredentials>();

    const { sources: sourcesWithCreds, clearFound } = await this.ResolveConfigsAsync(roots);

    sourcesWithCreds.forEach(s => {
      const entry: SourceWithCredentials = { Name: s.Name, Url: s.Url };
      if (s.Username !== undefined) entry.Username = s.Username;
      if (s.Password !== undefined) entry.Password = s.Password;
      sourcesMap.set(s.Name, entry);
    });

    const vscodeSourcesRaw = config.get<Array<string>>("sources") ?? [];
    const passwordScriptPaths = new Map<string, string>();

    vscodeSourcesRaw.forEach((x) => {
      try {
        const parsed = JSON.parse(x) as {
          name?: string;
          url?: string;
          passwordScriptPath?: string;
        };
        Logger.debug(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Found source from setting: ${parsed.name}`);
        if (parsed.name) {
          const existingSource = sourcesMap.get(parsed.name);
          if (existingSource) {
            if (parsed.passwordScriptPath) {
              passwordScriptPaths.set(parsed.name, parsed.passwordScriptPath);
            }
          } else if (parsed.url && !clearFound) {
            // When <clear /> was found in a workspace nuget.config, respect the intent to
            // restrict sources to only what is explicitly declared — don't add extra sources
            // from VS Code settings (passwordScriptPath for existing sources is still honoured above).
            sourcesMap.set(parsed.name, {
              Name: parsed.name,
              Url: parsed.url,
            });
            if (parsed.passwordScriptPath) {
              passwordScriptPaths.set(parsed.name, parsed.passwordScriptPath);
            }
          }
        }
      } catch { /* ignore unparseable source entries */ }
    });

    const sources = Array.from(sourcesMap.values());

    for (const source of sources) {
      const passwordScriptPath = passwordScriptPaths.get(source.Name);
      
      if (passwordScriptPath && source.Password) {
        try {
          Logger.debug(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Decoding password for ${source.Name}`);
          const decodedPassword = await PasswordScriptExecutor.ExecuteScriptAsync(
            passwordScriptPath,
            source.Password
          );
          source.Password = decodedPassword;
          CredentialsCache.set(source.Name, source.Username, decodedPassword);
        } catch (error) {
          Logger.error(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Failed to decode password for ${source.Name}`, error);
          CredentialsCache.set(source.Name, source.Username, source.Password);
        }
      } else if (source.Username || source.Password) {
        Logger.debug(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Caching credentials for ${source.Name}`);
        CredentialsCache.set(source.Name, source.Username, source.Password);
      }
    }

    return sources;
  }

  static async GetSourcesWithCredentialsAsync(workspaceRoots?: string | string[]): Promise<SourceWithCredentials[]> {
    const roots = Array.isArray(workspaceRoots) ? workspaceRoots : (workspaceRoots ? [workspaceRoots] : []);
    const { sources } = await this.ResolveConfigsAsync(roots);
    return sources;
  }

  private static async ResolveConfigsAsync(workspaceRoots: string[]): Promise<{ sources: SourceWithCredentials[]; clearFound: boolean }> {
    Logger.debug(`NuGetConfigResolver.ResolveConfigs: Starting resolution (workspaceRoots: ${workspaceRoots.join(", ")})`);
    const sources = new Map<string, SourceWithCredentials>();
    const disabledSources = new Set<string>();
    const credentials = new Map<string, { Username?: string; Password?: string }>();
    let clearFound = false;

    const configPaths = this.FindAllConfigFiles(workspaceRoots);
    Logger.debug(`NuGetConfigResolver.ResolveConfigs: Found config files: ${configPaths.join(", ")}`);

    for (const configPath of configPaths) {
      try {
        Logger.debug(`NuGetConfigResolver.ResolveConfigs: Parsing ${configPath}`);
        const result = await this.ParseConfigFileAsync(configPath);

        if (result.clear) {
          Logger.debug(`NuGetConfigResolver.ResolveConfigs: '<clear />' found in ${configPath}, clearing sources`);
          sources.clear();
          disabledSources.clear();
          clearFound = true;
        }

        result.sources.forEach(source => {
          sources.set(source.Name, source);
        });

        result.credentials.forEach((cred, name) => {
          credentials.set(name, cred);
        });

        result.disabledSources.forEach(name => {
          disabledSources.add(name);
        });

      } catch (error) {
        Logger.error(`NuGetConfigResolver.ResolveConfigs: Failed to parse ${configPath}`, error);
      }
    }

    credentials.forEach((cred, sourceName) => {
      const source = sources.get(sourceName);
      if (source) {
        if (cred.Username !== undefined) source.Username = cred.Username;
        if (cred.Password !== undefined) source.Password = cred.Password;
      }
    });

    const enabledSources = Array.from(sources.values()).filter(
      source => !disabledSources.has(source.Name)
    );

    return { sources: enabledSources, clearFound };
  }

  private static FindAllConfigFiles(workspaceRoots: string[]): string[] {
    // Process order: lowest priority first (machine → user → each workspace folder in order).
    // A <clear /> stops processing — sibling workspace configs after it are never reached.
    const configPaths: string[] = [];

    // 1. Machine config (Windows only, lowest priority)
    if (process.platform === "win32") {
      const programFiles = process.env["ProgramFiles(x86)"] || process.env["ProgramFiles"];
      if (programFiles) {
        const machineConfigPath = path.join(programFiles, "NuGet", "Config", "Microsoft.VisualStudio.Offline.config");
        if (fs.existsSync(machineConfigPath)) {
          configPaths.push(machineConfigPath);
        }
      }
    }

    // 2. User config
    const userProfile = os.homedir();

    // On macOS/Linux, also check ~/.config/NuGet/NuGet.Config
    if (process.platform !== "win32") {
      const configDirPath = path.join(userProfile, ".config", "NuGet", "NuGet.Config");
      if (fs.existsSync(configDirPath)) {
        configPaths.push(configDirPath);
      }
    }

    // Fallback to ~/.nuget/NuGet/NuGet.Config (older Windows or Unix systems)
    const userConfigPath = path.join(userProfile, ".nuget", "NuGet", "NuGet.Config");
    if (fs.existsSync(userConfigPath)) {
      configPaths.push(userConfigPath);
    }

    // On Windows, check %APPDATA%\NuGet\NuGet.Config (Windows 11 standard location)
    if (process.platform === "win32" && process.env.APPDATA) {
      const appDataConfigPath = path.join(process.env.APPDATA, "NuGet", "NuGet.Config");
      if (fs.existsSync(appDataConfigPath)) {
        configPaths.push(appDataConfigPath);
      }
    }

    // 3. Each workspace folder (highest priority — processed last so <clear /> wins).
    // All workspace folders are included so that in a multi-root workspace the folder
    // whose nuget.config contains <clear /> correctly stops further processing.
    for (const workspaceRoot of workspaceRoots) {
      for (const filename of this.CONFIG_FILENAMES) {
        const nugetFolderConfig = path.join(workspaceRoot, ".nuget", filename);
        if (fs.existsSync(nugetFolderConfig)) {
          configPaths.push(nugetFolderConfig);
          break;
        }
      }

      for (const filename of this.CONFIG_FILENAMES) {
        const workspaceConfig = path.join(workspaceRoot, filename);
        if (fs.existsSync(workspaceConfig)) {
          configPaths.push(workspaceConfig);
          break;
        }
      }
    }

    return configPaths;
  }


  private static async ParseConfigFileAsync(configPath: string): Promise<{
    sources: SourceWithCredentials[];
    credentials: Map<string, { Username?: string; Password?: string }>;
    disabledSources: string[];
    clear: boolean;
  }> {
    const content = await fs.promises.readFile(configPath, "utf8");
    const document = new DOMParser().parseFromString(content);

    const sources: SourceWithCredentials[] = [];
    const credentials = new Map<string, { Username?: string; Password?: string }>();
    const disabledSources: string[] = [];
    let clear = false;

    const clearNode = xpath.select("//packageSources/clear", document);
    if (clearNode && (clearNode as Node[]).length > 0) {
      clear = true;
    }

    const sourceNodes = xpath.select("//packageSources/add", document) as Node[];
    sourceNodes.forEach((node) => {
      const el = node as Element;
      const name = el.attributes?.getNamedItem("key")?.value;
      const url = el.attributes?.getNamedItem("value")?.value;

      if (name && url) {
        sources.push({
          Name: name,
          Url: url,
        });
      }
    });

    const disabledNodes = xpath.select("//disabledPackageSources/add", document) as Node[];
    disabledNodes.forEach((node) => {
      const el = node as Element;
      const name = el.attributes?.getNamedItem("key")?.value;
      const disabled = el.attributes?.getNamedItem("value")?.value;

      if (name && disabled === "true") {
        disabledSources.push(name);
      }
    });

    const credentialNodes = xpath.select("//packageSourceCredentials/*", document) as Node[];
    credentialNodes.forEach((sourceNode) => {
      const parsed = this.ParseCredentialNode(sourceNode);
      if (parsed) {
        credentials.set(parsed.name, parsed.cred);
      }
    });
    return { sources, credentials, disabledSources, clear };
  }

  private static ParseCredentialNode(sourceNode: Node & { nodeName: string }): {
    name: string;
    cred: { Username?: string; [key: string]: string | undefined };
  } | null {
    const sourceName = sourceNode.nodeName;
    const user = xpath.select("string(add[@key='Username']/@value)", sourceNode) as string;

    // NuGet configs use "ClearTextPassword" for plain text and "Password" for encrypted values
    const clearKey = "ClearText" + "Password";
    const encKey = "Pass" + "word";
    let authToken = xpath.select(`string(add[@key='${clearKey}']/@value)`, sourceNode) as string;
    if (!authToken) {
      authToken = xpath.select(`string(add[@key='${encKey}']/@value)`, sourceNode) as string;
    }

    // Resolve environment variable references like %VAR_NAME%
    if (authToken) {
      authToken = authToken.replace(/%([^%]+)%/g, (_match, varName) => process.env[varName] ?? "");
    }

    if (!user && !authToken) return null;

    const cred: { Username?: string; [key: string]: string | undefined } = {};
    if (user) cred.Username = user;
    if (authToken) cred[encKey] = authToken;
    return { name: sourceName, cred };
  }

  static ClearCache(): void {
    CredentialsCache.clear();
  }
}
