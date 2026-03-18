/**
 * Centralized cache for decoded credentials with a 5-minute TTL.
 * Shared between get-configuration.ts and api-factory.ts
 */

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  username?: string;
  password?: string;
  timestamp: number;
}

class CredentialsCache {
  private cache = new Map<string, CacheEntry>();

  set(sourceName: string, username?: string, password?: string): void {
    const entry: CacheEntry = { timestamp: Date.now() };
    if (username !== undefined) entry.username = username;
    if (password !== undefined) entry.password = password;
    this.cache.set(sourceName, entry);
  }

  get(sourceName: string): { username?: string; password?: string } | undefined {
    const entry = this.cache.get(sourceName);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.cache.delete(sourceName);
      return undefined;
    }
    const { username, password } = entry;
    const result: { username?: string; password?: string } = {};
    if (username !== undefined) result.username = username;
    if (password !== undefined) result.password = password;
    return result;
  }

  has(sourceName: string): boolean {
    return this.get(sourceName) !== undefined;
  }

  clear(): void {
    this.cache.clear();
  }

  clearExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}

export default new CredentialsCache();
