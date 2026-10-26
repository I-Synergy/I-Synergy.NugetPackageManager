/** NuGet SemVer comparison and version-range matching. */

export function compareVersions(a: string, b: string): number {
  // Strip NuGet version range brackets/parentheses and build metadata (+...).
  const stripOuter = (v: string) => v.replace(/[[\]()]/g, "").split("+")[0] ?? v;
  const cleanA = stripOuter(a);
  const cleanB = stripOuter(b);

  // Separate release tuple from prerelease label on the FIRST hyphen only.
  // NuGet follows SemVer: 1.0.0-beta is a prerelease of 1.0.0.
  const firstDashA = cleanA.indexOf("-");
  const firstDashB = cleanB.indexOf("-");
  const releaseA = firstDashA >= 0 ? cleanA.substring(0, firstDashA) : cleanA;
  const releaseB = firstDashB >= 0 ? cleanB.substring(0, firstDashB) : cleanB;
  const prereleaseA = firstDashA >= 0 ? cleanA.substring(firstDashA + 1) : "";
  const prereleaseB = firstDashB >= 0 ? cleanB.substring(firstDashB + 1) : "";

  // Compare numeric release components (major.minor.patch[.revision]).
  const toNumParts = (s: string) =>
    s.split(".").map((p) => {
      const n = parseInt(p, 10);
      return isNaN(n) ? 0 : n;
    });
  const numA = toNumParts(releaseA);
  const numB = toNumParts(releaseB);
  const maxLen = Math.max(numA.length, numB.length);
  for (let i = 0; i < maxLen; i++) {
    const pA = numA[i] ?? 0;
    const pB = numB[i] ?? 0;
    if (pA !== pB) return pA - pB;
  }

  // Numeric parts are equal — apply NuGet prerelease precedence: a stable
  // release is always greater than any prerelease of the same base version.
  if (prereleaseA === "" && prereleaseB === "") return 0;
  if (prereleaseA === "") return 1;
  if (prereleaseB === "") return -1;

  // Both have prerelease labels: numeric identifiers compare numerically,
  // alphanumeric identifiers lexicographically.
  const preA = prereleaseA.split(".");
  const preB = prereleaseB.split(".");
  const preLen = Math.max(preA.length, preB.length);
  for (let i = 0; i < preLen; i++) {
    const pA = preA[i] ?? "";
    const pB = preB[i] ?? "";
    if (pA === pB) continue;
    const nA = parseInt(pA, 10);
    const nB = parseInt(pB, 10);
    if (!isNaN(nA) && !isNaN(nB)) return nA - nB;
    return pA.localeCompare(pB);
  }
  return 0;
}

/**
 * NuGet interval notation:
 *   [1.0.0, 2.0.0)  -> >= 1.0.0 AND < 2.0.0
 *   (1.0.0, 2.0.0]  -> > 1.0.0 AND <= 2.0.0
 *   [1.0.0, )       -> >= 1.0.0
 *   (, 2.0.0)       -> < 2.0.0
 *   [1.0.0]         -> exact
 */
export function isVersionInRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed) return false;

  const lowerInclusive = trimmed.startsWith("[");
  const upperInclusive = trimmed.endsWith("]");

  const inner = trimmed.slice(1, -1);
  const commaIdx = inner.indexOf(",");

  if (commaIdx === -1) {
    if (lowerInclusive && upperInclusive) {
      return compareVersions(version, inner.trim()) === 0;
    }
    return false;
  }

  const lowerBound = inner.substring(0, commaIdx).trim();
  const upperBound = inner.substring(commaIdx + 1).trim();

  if (lowerBound) {
    const cmp = compareVersions(version, lowerBound);
    if (lowerInclusive && cmp < 0) return false;
    if (!lowerInclusive && cmp <= 0) return false;
  }

  if (upperBound) {
    const cmp = compareVersions(version, upperBound);
    if (upperInclusive && cmp > 0) return false;
    if (!upperInclusive && cmp >= 0) return false;
  }

  return true;
}

/** Lowercased release version used by vulnerability lists. */
export function normalizeVersion(version: string): string {
  return version.split("+")[0]!.toLowerCase();
}

/**
 * Evaluates a NuGet dependency range against a concrete version.
 *
 * - interval / exact notation is delegated to `isVersionInRange`
 *   (`[1.0.0]`, `[1.0.0, 2.0.0)`, ...)
 * - a bare version means "at least" (NuGet's shorthand in nuspec files)
 * - floating ranges such as `1.*` / `1.2.*` match the prefix
 * - `*` matches everything
 *
 * An empty or unparseable range is treated as unconstrained so a suggestion is
 * never hidden because the metadata could not be understood.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*") return true;

  if (/[[\]()]/.test(trimmed)) {
    // Interval notation is only meaningful when it is actually a range. A bare
    // value in parentheses would already be caught above.
    return isVersionInRange(version, trimmed);
  }

  if (trimmed.endsWith(".*")) {
    const prefix = trimmed.slice(0, -1);
    return version.toLowerCase().startsWith(prefix.toLowerCase());
  }

  return compareVersions(version, trimmed) >= 0;
}
