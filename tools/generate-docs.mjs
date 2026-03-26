/**
 * Self-contained docs generator: builds the extension, starts the dev server,
 * captures screenshots and the demo GIF, then cleans up.
 *
 * Usage:  npm run docs
 *         node ./tools/generate-docs.mjs
 */
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, opts = {}) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function log(msg) {
  console.log(`\n[docs] ${msg}`);
}

// ── 1. Install capture dependencies ──────────────────────────────────────────
log('Installing capture dependencies...');
run('npm install --save-dev playwright gif-encoder-2 pngjs');
run('npx playwright install chromium');

// ── 2. Build the extension ───────────────────────────────────────────────────
log('Building extension...');
run('node ./esbuild.js');

// ── 3. Start dev server in background ────────────────────────────────────────
log('Starting dev server...');
const server = spawn('node', ['./tools/dev-server.mjs'], {
  cwd: ROOT,
  stdio: 'ignore',
  detached: false,
});

// Give the server a moment to start
await new Promise(r => setTimeout(r, 3500));

try {
  // ── 4. Take screenshots ─────────────────────────────────────────────────────
  log('Taking screenshots...');
  run('node ./tools/screenshot.mjs');

  // ── 5. Record demo GIF ──────────────────────────────────────────────────────
  log('Recording demo GIF...');
  run('node ./tools/record-demo.mjs');

  log('Done! docs/images/ updated.');
} finally {
  // ── 6. Kill dev server ──────────────────────────────────────────────────────
  log('Stopping dev server...');
  server.kill();
  // Belt-and-suspenders: kill anything still on port 3729
  try { execSync('npx kill-port 3729', { cwd: ROOT, stdio: 'ignore' }); } catch { /* ok */ }

  // ── 7. Uninstall capture dependencies ────────────────────────────────────────
  log('Cleaning up capture dependencies...');
  run('npm uninstall playwright gif-encoder-2 pngjs');
}
