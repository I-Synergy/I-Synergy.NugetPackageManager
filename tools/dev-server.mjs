/**
 * Development server for NuGet Package Manager UI.
 *
 * Serves the webview bundle with mock data so the UI can be iterated on
 * in a regular browser without a VS Code workspace or dotnet CLI.
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

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];

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

  // Open in default browser
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd);

  console.log('Press Ctrl+C to stop.\n');
});
