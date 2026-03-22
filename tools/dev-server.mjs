/**
 * Development server for NuGet Package Manager UI.
 *
 * Serves the webview bundle with mock data so the UI can be iterated on
 * in a regular browser without a VS Code workspace or dotnet CLI.
 *
 * Project/package references are mocked. All NuGet package data (search,
 * versions, updates, vulnerabilities) is fetched live from nuget.org.
 *
 * Usage: npm run dev
 *   → opens http://localhost:3729 in the default browser
 */

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..');
const TOOLS_DIR = __dirname;
const DIST_DIR = join(ROOT_DIR, 'dist');

const PORT = 3729;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
};

// ── NuGet service URL cache (keyed by index URL) ──────────────────────────────

const _serviceCache = new Map();

async function getNugetServices(indexUrl = 'https://api.nuget.org/v3/index.json') {
  if (_serviceCache.has(indexUrl)) return _serviceCache.get(indexUrl);

  console.log(`[nuget-proxy] Resolving service URLs from ${indexUrl}`);
  const res = await fetch(indexUrl);
  const data = await res.json();
  const resources = data.resources || [];

  const findUrl = (type) => {
    const matches = resources
      .filter(r => r['@type'].includes(type))
      .sort((a, b) => b['@type'].localeCompare(a['@type']));
    return matches[0]?.['@id'] || '';
  };

  const services = {
    search: findUrl('SearchQueryService'),
    registration: findUrl('RegistrationsBaseUrl'),
    vulnerability: findUrl('VulnerabilityInfo'),
  };
  _serviceCache.set(indexUrl, services);
  return services;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchRegistrationItems(registrationBaseUrl, pkgId) {
  const url = `${registrationBaseUrl}${pkgId.toLowerCase()}/index.json`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const items = [];
  for (const page of data.items || []) {
    if (page.items) {
      items.push(...page.items);
    } else {
      const pageRes = await fetch(page['@id']);
      const pageData = await pageRes.json();
      items.push(...(pageData.items || []));
    }
  }
  return items;
}

function parseVersion(v) {
  // Returns { parts: number[], pre: string|null }
  // e.g. "1.2.3-alpha.1" → { parts: [1,2,3], pre: "alpha.1" }
  const [numeric, ...preParts] = (v || '').split('-');
  const pre = preParts.length > 0 ? preParts.join('-') : null;
  const parts = (numeric || '').split('.').map(n => parseInt(n, 10) || 0);
  return { parts, pre };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  // Compare numeric parts first
  for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  // Per semver: release > prerelease (null > non-null)
  if (pa.pre === null && pb.pre !== null) return 1;
  if (pa.pre !== null && pb.pre === null) return -1;
  if (pa.pre !== null && pb.pre !== null) return pa.pre.localeCompare(pb.pre);
  return 0;
}

function isVersionInRange(version, range) {
  if (!range) return false;
  try {
    // Match NuGet range notation: [min,max], (min,max), [min,), etc.
    // Version segments may include prerelease labels like "1.0.0-alpha"
    const match = range.match(/^([\[\(])\s*([^,]*?)\s*,\s*([^,]*?)\s*([\]\)])$/);
    if (!match) {
      const exact = range.match(/^\[\s*([^\]]+?)\s*\]$/);
      return exact ? compareVersions(version, exact[1]) === 0 : false;
    }
    const [, openBracket, minVer, maxVer, closeBracket] = match;
    if (minVer) {
      const cmp = compareVersions(version, minVer);
      if (openBracket === '[' && cmp < 0) return false;
      if (openBracket === '(' && cmp <= 0) return false;
    }
    if (maxVer) {
      const cmp = compareVersions(version, maxVer);
      if (closeBracket === ']' && cmp > 0) return false;
      if (closeBracket === ')' && cmp >= 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function mapSearchItem(item) {
  return {
    Id: item['@id'] || '',
    Name: item.id || '',
    Authors: item.authors || [],
    Description: item.description || '',
    IconUrl: item.iconUrl || '',
    Registration: item.registration || '',
    LicenseUrl: item.licenseUrl || '',
    ProjectUrl: item.projectUrl || '',
    TotalDownloads: item.totalDownloads || 0,
    Verified: item.verified || false,
    Version: item.version || '',
    InstalledVersion: '',
    Versions: (item.versions || []).map(v => ({ Version: v.version, Id: v['@id'] })),
    Tags: item.tags || [],
  };
}

function mapCatalogEntry(item, allItems) {
  const ce = typeof item.catalogEntry === 'object' ? item.catalogEntry : {};
  return {
    Id: item['@id'] || '',
    Name: ce.id || '',
    Authors: typeof ce.authors === 'string' ? [ce.authors] : (ce.authors || []),
    Description: ce.description || '',
    IconUrl: ce.iconUrl || '',
    Registration: ce.registration || '',
    LicenseUrl: ce.licenseUrl || '',
    ProjectUrl: ce.projectUrl || '',
    TotalDownloads: ce.totalDownloads || 0,
    Verified: ce.verified || false,
    Version: ce.version || '',
    InstalledVersion: '',
    Versions: (allItems || [item]).map(v => ({
      Version: (typeof v.catalogEntry === 'object' ? v.catalogEntry.version : '') || '',
      Id: v['@id'] || '',
    })),
    Tags: ce.tags || [],
  };
}

// ── NuGet RPC proxy ───────────────────────────────────────────────────────────

async function handleNugetProxy(method, params) {
  const sourceUrl = params?.Url || 'https://api.nuget.org/v3/index.json';
  const services = await getNugetServices(sourceUrl);

  switch (method) {
    case 'getPackagesAsync': {
      const searchBase = services.search.endsWith('/') ? services.search.slice(0, -1) : services.search;
      const searchUrl = new URL(searchBase);
      searchUrl.searchParams.set('q', params.Filter || '');
      searchUrl.searchParams.set('take', String(params.Take ?? 20));
      searchUrl.searchParams.set('skip', String(params.Skip ?? 0));
      searchUrl.searchParams.set('prerelease', String(params.Prerelease ?? false));
      searchUrl.searchParams.set('semVerLevel', '2.0.0');
      const res = await fetch(searchUrl.toString());
      const data = await res.json();
      return { ok: true, value: { Packages: (data.data || []).map(mapSearchItem) } };
    }

    case 'getPackageAsync': {
      const items = await fetchRegistrationItems(services.registration, params.Id);
      if (!items.length) return { ok: false, error: `Package ${params.Id} not found` };

      const filtered = params.Prerelease
        ? items
        : items.filter(v => {
            const ce = typeof v.catalogEntry === 'object' ? v.catalogEntry : null;
            return !ce?.version?.includes('-');
          });
      const toUse = filtered.length > 0 ? filtered : items;
      const last = toUse[toUse.length - 1];
      return { ok: true, value: { Package: mapCatalogEntry(last, toUse), SourceUrl: sourceUrl } };
    }

    case 'getPackageDetailsAsync': {
      const pvUrl = params.PackageVersionUrl;
      if (!pvUrl) return { ok: true, value: { Package: { dependencies: { frameworks: {} } } } };

      const pvRes = await fetch(pvUrl);
      if (!pvRes.ok) return { ok: true, value: { Package: { dependencies: { frameworks: {} } } } };
      const pvData = await pvRes.json();

      let catalogData;
      const ce = pvData.catalogEntry;
      if (typeof ce === 'object' && ce !== null && Array.isArray(ce.dependencyGroups)) {
        catalogData = ce;
      } else {
        const catalogUrl = typeof ce === 'string' ? ce : ce?.['@id'];
        if (!catalogUrl) return { ok: true, value: { Package: { dependencies: { frameworks: {} } } } };
        const catRes = await fetch(catalogUrl);
        catalogData = await catRes.json();
      }

      const frameworks = {};
      for (const group of catalogData?.dependencyGroups || []) {
        const deps = (group.dependencies || []).map(d => ({ package: d.id, versionRange: d.range }));
        if (deps.length > 0) frameworks[group.targetFramework] = deps;
      }
      return { ok: true, value: { Package: { dependencies: { frameworks } } } };
    }

    case 'getOutdatedPackagesAsync': {
      // _installedPackages: [{ id, version, projects: [{ Name, Path, Version }] }]
      const installed = params._installedPackages || [];
      const outdated = [];

      await Promise.all(installed.map(async ({ id, version, projects }) => {
        try {
          const items = await fetchRegistrationItems(services.registration, id);
          if (!items.length) return;

          const filtered = params.Prerelease
            ? items
            : items.filter(v => {
                const ce = typeof v.catalogEntry === 'object' ? v.catalogEntry : null;
                return !ce?.version?.includes('-');
              });
          const toUse = filtered.length > 0 ? filtered : items;
          const latestVersion = (typeof toUse[toUse.length - 1].catalogEntry === 'object'
            ? toUse[toUse.length - 1].catalogEntry.version : '') || '';

          if (latestVersion && compareVersions(latestVersion, version) > 0) {
            outdated.push({
              Id: id,
              InstalledVersion: version,
              LatestVersion: latestVersion,
              Projects: projects,
              SourceUrl: sourceUrl,
              SourceName: 'nuget.org',
            });
          }
        } catch (e) {
          console.warn(`[nuget-proxy] getOutdatedPackagesAsync: failed for ${id}:`, e.message);
        }
      }));

      return { ok: true, value: { Packages: outdated } };
    }

    case 'getVulnerablePackagesAsync': {
      // _installedPackages: [{ id, version, projects: [{ Name, Path, Version }] }]
      const installed = params._installedPackages || [];
      if (!services.vulnerability || !installed.length) {
        return { ok: true, value: { Packages: [] } };
      }

      const vulnRes = await fetch(services.vulnerability);
      if (!vulnRes.ok) return { ok: true, value: { Packages: [] } };
      const vulnIndex = await vulnRes.json();

      const vulnMap = {};
      await Promise.all(vulnIndex.map(async page => {
        try {
          const pageRes = await fetch(page['@id']);
          const pageData = await pageRes.json();
          for (const [pkgId, entries] of Object.entries(pageData)) {
            vulnMap[pkgId.toLowerCase()] = entries;
          }
        } catch (e) {
          console.warn('[nuget-proxy] getVulnerablePackagesAsync: failed to fetch page:', e.message);
        }
      }));

      const vulnerable = [];
      for (const { id, version, projects } of installed) {
        const entries = vulnMap[id.toLowerCase()];
        if (!entries) continue;
        for (const entry of entries) {
          if (isVersionInRange(version, entry.versions)) {
            vulnerable.push({
              Id: id,
              InstalledVersion: version,
              Severity: entry.severity,
              AdvisoryUrl: entry.advisoryUrl,
              AffectedVersionRange: entry.versions,
              Projects: projects,
            });
            break;
          }
        }
      }

      return { ok: true, value: { Packages: vulnerable } };
    }

    default:
      return { ok: false, error: `Unknown NuGet proxy method: ${method}` };
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // NuGet proxy endpoint
  if (req.method === 'POST' && url === '/nuget-proxy') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { method, params } = JSON.parse(body);
        console.log(`[nuget-proxy] → ${method}`);
        const result = await handleNugetProxy(method, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[nuget-proxy] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Static file serving
  let filePath;
  if (url.startsWith('/dist/')) {
    filePath = join(DIST_DIR, url.slice('/dist/'.length));
  } else if (url === '/' || url === '/index.html') {
    filePath = join(TOOLS_DIR, 'index.html');
  } else {
    filePath = join(TOOLS_DIR, url.slice(1));
  }

  try {
    const data = await readFile(filePath);
    const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found: ' + url);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nDev server running at ${url}\n`);

  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd);

  console.log('Press Ctrl+C to stop.\n');
});
