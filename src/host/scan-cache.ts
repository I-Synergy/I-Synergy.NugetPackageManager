import type * as vscode from "vscode";
import type { GetOutdatedPackagesResponse } from "@/common/rpc/types";

const STORAGE_KEY = "nugetpackagemanager.lastScan";
const SCHEMA_VERSION = 1;

export type ScanCachePayload = {
    Packages: OutdatedPackage[];
    BlockedPackages: NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]>;
};

export type ScanCacheEntry = ScanCachePayload & {
    SchemaVersion: number;
    Key: string;
    ScannedAt: string;
};

export type ScanCacheKeyParts = {
    workspaceRoots: string[];
    projectPaths: string[];
    sourceUrls: string[];
    prerelease: boolean;
    excludeGlobs: string[];
};

/** FNV-1a; keeps the persisted key short and stable. */
function hashKey(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function BuildScanCacheKey(parts: ScanCacheKeyParts): string {
    const normalized = JSON.stringify({
        workspaceRoots: [...parts.workspaceRoots].map((root) => root.toLowerCase()).sort(),
        projectPaths: [...parts.projectPaths].map((project) => project.toLowerCase()).sort(),
        sourceUrls: [...parts.sourceUrls].map((url) => url.toLowerCase()).sort(),
        prerelease: parts.prerelease,
        excludeGlobs: [...parts.excludeGlobs].sort(),
    });
    return `scan:${hashKey(normalized)}`;
}

/**
 * Persists the last Updates scan in `workspaceState` so the tab can paint
 * immediately on activation/window reload while a live scan refreshes.
 *
 * `memento` is optional: host tests and headless callers run without a cache.
 */
export class ScanCacheStore {
    constructor(private readonly memento?: vscode.Memento) {}

    async LoadAsync(key: string): Promise<ScanCacheEntry | null> {
        if (!this.memento) return null;
        const entry = this.memento.get<ScanCacheEntry>(STORAGE_KEY);
        if (!entry) return null;
        if (entry.SchemaVersion !== SCHEMA_VERSION || entry.Key !== key) return null;
        if (!Array.isArray(entry.Packages)) return null;
        return entry;
    }

    async SaveAsync(entry: Omit<ScanCacheEntry, "SchemaVersion">): Promise<void> {
        if (!this.memento) return;
        await this.memento.update(STORAGE_KEY, { SchemaVersion: SCHEMA_VERSION, ...entry });
    }

    async ClearAsync(): Promise<void> {
        if (!this.memento) return;
        await this.memento.update(STORAGE_KEY, undefined);
    }
}

export const SCAN_CACHE_SCHEMA_VERSION = SCHEMA_VERSION;
