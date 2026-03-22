import fs from "fs";
import * as path from "path";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import { Logger } from "../../common/logger";

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

  static async UpdatePackageVersionAsync(projectPath: string, packageId: string, newVersion: string): Promise<void> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      throw new Error(`Directory.Packages.props not found for ${projectPath}`);
    }

    const content = await fs.promises.readFile(cpmFilePath, "utf8");
    const escaped = packageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Handle: Include="PackageId" ... Version="oldVersion"
    let updated = content.replace(
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
}
