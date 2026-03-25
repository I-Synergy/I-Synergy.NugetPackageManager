import fs from "fs";
import * as path from "path";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import { Logger } from "../../common/logger";

export type CpmFrameworkEntry = {
  condition: string;  // raw XML Condition value, e.g. "$(TargetFramework.StartsWith('net8.0'))"
  framework: string;  // parsed label, e.g. "net8.0"
  versions: Map<string, string>;
};

export type CpmPackageMap = {
  unconditional: Map<string, string>;
  conditional: CpmFrameworkEntry[];
};

export default class CpmResolver {
  static async GetPackageVersionsAsync(projectPath: string): Promise<Map<string, string> | null> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      return null;
    }

    Logger.debug(`CpmResolver.GetPackageVersions: Found CPM file at ${cpmFilePath}`);

    if (!await this.IsCentralPackageManagementEnabledAsync(projectPath, cpmFilePath)) {
      Logger.debug(`CpmResolver.GetPackageVersions: CPM is disabled for ${projectPath}`);
      return null;
    }

    return this.ParsePackageVersionsAsync(cpmFilePath);
  }

  static async GetFrameworkPackageMapAsync(projectPath: string): Promise<CpmPackageMap | null> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      return null;
    }

    Logger.debug(`CpmResolver.GetFrameworkPackageMap: Found CPM file at ${cpmFilePath}`);

    if (!await this.IsCentralPackageManagementEnabledAsync(projectPath, cpmFilePath)) {
      Logger.debug(`CpmResolver.GetFrameworkPackageMap: CPM is disabled for ${projectPath}`);
      return null;
    }

    return this.ParseFrameworkPackageMapAsync(cpmFilePath);
  }

  /**
   * Resolves the `Directory.Packages.props` path for a project if CPM is enabled,
   * or returns `null` if CPM is not applicable. Use the returned path as a cache key
   * so that multiple projects sharing the same props file can reuse a single parse.
   */
  static async FindCpmFilePathAsync(projectPath: string): Promise<string | null> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      return null;
    }

    if (!await this.IsCentralPackageManagementEnabledAsync(projectPath, cpmFilePath)) {
      return null;
    }

    return cpmFilePath;
  }

  /**
   * Parses a `Directory.Packages.props` file directly (without project-path look-up)
   * and returns its full framework-aware package map. Callers should cache the result
   * by `cpmFilePath` to avoid re-reading a shared file for each project.
   */
  static async ParseCpmFileAsync(cpmFilePath: string): Promise<CpmPackageMap> {
    return this.ParseFrameworkPackageMapAsync(cpmFilePath);
  }

  private static async FindDirectoryPackagesPropsFileAsync(projectPath: string): Promise<string | null> {
    let currentDir = path.dirname(projectPath);
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const cpmPath = path.join(currentDir, "Directory.Packages.props");
      try {
        await fs.promises.access(cpmPath);
        return cpmPath;
      } catch {
        // file doesn't exist at this level, walk up
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return null;
  }

  private static async IsCentralPackageManagementEnabledAsync(projectPath: string, cpmFilePath: string): Promise<boolean> {
    try {
      // Check if Directory.Packages.props has CPM enabled
      const cpmContent = await fs.promises.readFile(cpmFilePath, "utf8");
      const cpmDoc = new DOMParser().parseFromString(cpmContent);
      const cpmEnabled = xpath.select("string(//PropertyGroup/ManagePackageVersionsCentrally)", cpmDoc);

      if (cpmEnabled !== "true") {
        return false;
      }

      // Check if project has CPM disabled
      const projectContent = await fs.promises.readFile(projectPath, "utf8");
      const projectDoc = new DOMParser().parseFromString(projectContent);
      const projectCpmSetting = xpath.select("string(//PropertyGroup/ManagePackageVersionsCentrally)", projectDoc);

      if (projectCpmSetting === "false") {
        return false;
      }

      return true;
    } catch (error) {
      Logger.error(`CpmResolver.IsCentralPackageManagementEnabled: Failed to check CPM status for ${projectPath}`, error);
      return false;
    }
  }

  static async UpdatePackageVersionAsync(
    projectPath: string,
    packageId: string,
    newVersion: string,
    condition?: string
  ): Promise<void> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      throw new Error(`Directory.Packages.props not found for ${projectPath}`);
    }

    const content = await fs.promises.readFile(cpmFilePath, "utf8");
    const escaped = packageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let updated: string;

    if (condition !== undefined) {
      // Scoped update: only modify within the matching <ItemGroup Condition="..."> block
      const escapedCondition = condition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const itemGroupRegex = new RegExp(
        `(<ItemGroup[^>]+Condition="${escapedCondition}"[^>]*>)(.*?)(</ItemGroup>)`,
        "s"
      );
      const itemGroupMatch = itemGroupRegex.exec(content);
      if (!itemGroupMatch) {
        throw new Error(`ItemGroup with Condition="${condition}" not found in ${cpmFilePath}`);
      }

      const fullMatch = itemGroupMatch[0]!;
      const openTag = itemGroupMatch[1]!;
      const body = itemGroupMatch[2]!;
      const closeTag = itemGroupMatch[3]!;

      // Apply version replacement within the ItemGroup body only
      let updatedBody = body.replace(
        new RegExp(`(Include="${escaped}"[^>]*?Version=")[^"]*"`),
        `$1${newVersion}"`
      );
      if (updatedBody === body) {
        updatedBody = body.replace(
          new RegExp(`(Version=")[^"]*("[^>]*?Include="${escaped}")`),
          `$1${newVersion}$2`
        );
      }
      if (updatedBody === body) {
        throw new Error(`Package ${packageId} not found in ItemGroup with Condition="${condition}" in ${cpmFilePath}`);
      }

      updated = content.replace(fullMatch, `${openTag}${updatedBody}${closeTag}`);
    } else {
      // Unconditional update: existing global behavior
      // Handle: Include="PackageId" ... Version="oldVersion"
      updated = content.replace(
        new RegExp(`(Include="${escaped}"[^>]*?Version=")[^"]*"`),
        `$1${newVersion}"`
      );

      // Handle: Version="oldVersion" ... Include="PackageId"
      if (updated === content) {
        updated = content.replace(
          new RegExp(`(Version=")[^"]*("[^>]*?Include="${escaped}")`),
          `$1${newVersion}$2`
        );
      }

      if (updated === content) {
        throw new Error(`Package ${packageId} not found in ${cpmFilePath}`);
      }
    }

    await fs.promises.writeFile(cpmFilePath, updated, "utf8");
    Logger.info(`CpmResolver.UpdatePackageVersion: Updated ${packageId} to ${newVersion} in ${cpmFilePath}`);
  }

  private static async ParsePackageVersionsAsync(cpmFilePath: string): Promise<Map<string, string>> {
    Logger.debug(`CpmResolver.ParsePackageVersions: Parsing ${cpmFilePath}`);
    const versionMap = new Map<string, string>();

    try {
      const cpmContent = await fs.promises.readFile(cpmFilePath, "utf8");
      const document = new DOMParser().parseFromString(cpmContent);
      const packageVersions = xpath.select("//ItemGroup/PackageVersion", document) as Node[];

      (packageVersions || []).forEach((p) => {
        const el = p as Element;
        const packageId = el.attributes?.getNamedItem("Include")?.value;
        const version = el.attributes?.getNamedItem("Version")?.value;

        if (packageId && version) {
          versionMap.set(packageId, version);
        }
      });

      Logger.debug(`CpmResolver.ParsePackageVersions: Found ${versionMap.size} package versions in ${cpmFilePath}`);
    } catch (error) {
      Logger.error(`CpmResolver.ParsePackageVersions: Failed to parse CPM versions from ${cpmFilePath}`, error);
    }

    return versionMap;
  }

  private static async ParseFrameworkPackageMapAsync(cpmFilePath: string): Promise<CpmPackageMap> {
    Logger.debug(`CpmResolver.ParseFrameworkPackageMap: Parsing ${cpmFilePath}`);
    const result: CpmPackageMap = { unconditional: new Map(), conditional: [] };

    try {
      const cpmContent = await fs.promises.readFile(cpmFilePath, "utf8");
      const document = new DOMParser().parseFromString(cpmContent);
      const itemGroups = xpath.select("//ItemGroup", document) as Node[];

      for (const node of itemGroups || []) {
        const el = node as Element;
        const condition = el.attributes?.getNamedItem("Condition")?.value?.trim() ?? "";

        const packageVersionNodes = xpath.select("PackageVersion", el) as Node[];
        if (!packageVersionNodes?.length) continue;

        if (!condition) {
          // Unconditional group
          for (const pvNode of packageVersionNodes) {
            const pv = pvNode as Element;
            const packageId = pv.attributes?.getNamedItem("Include")?.value;
            const version = pv.attributes?.getNamedItem("Version")?.value;
            if (packageId && version) {
              result.unconditional.set(packageId, version);
            }
          }
        } else {
          // Conditional group — find or create entry
          let entry = result.conditional.find((e) => e.condition === condition);
          if (!entry) {
            entry = {
              condition,
              framework: this.parseCpmConditionLabel(condition),
              versions: new Map(),
            };
            result.conditional.push(entry);
          }
          for (const pvNode of packageVersionNodes) {
            const pv = pvNode as Element;
            const packageId = pv.attributes?.getNamedItem("Include")?.value;
            const version = pv.attributes?.getNamedItem("Version")?.value;
            if (packageId && version) {
              entry.versions.set(packageId, version);
            }
          }
        }
      }

      Logger.debug(
        `CpmResolver.ParseFrameworkPackageMap: Found ${result.unconditional.size} unconditional, ` +
        `${result.conditional.length} conditional group(s) in ${cpmFilePath}`
      );
    } catch (error) {
      Logger.error(`CpmResolver.ParseFrameworkPackageMap: Failed to parse ${cpmFilePath}`, error);
    }

    return result;
  }

  private static parseCpmConditionLabel(condition: string): string {
    const m = condition.match(/(net\d+\.\d+(?:-\w+)?|netstandard\d+\.\d+|netcoreapp\d+\.\d+)/i);
    if (m) return m[1]!.toLowerCase();
    return condition.replace(/[$()'"]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  }
}
