/**
 * Centralized cache for decoded credentials
 * Shared between get-configuration.ts and api-factory.ts
 */
class CredentialsCache {
  private cache = new Map<string, { username?: string; password?: string }>();

  /**
   * Store decoded credentials for a source by name
   */
  set(sourceName: string, username?: string, password?: string): void {
    this.cache.set(sourceName, { username, password });
  }

  /**
   * Retrieve credentials by source name
   */
  get(sourceName: string): { username?: string; password?: string } | undefined {
    return this.cache.get(sourceName);
  }

  /**
   * Clear all cached credentials
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Check if credentials exist for a source name
   */
  has(sourceName: string): boolean {
    return this.cache.has(sourceName);
  }
}

export default new CredentialsCache();
