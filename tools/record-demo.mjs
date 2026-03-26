/**
 * Records a demo GIF of the extension UI using the dev server.
 * Run: node ./tools/record-demo.mjs
 * Requires the dev server to be running on http://localhost:3729
 */
import { chromium } from 'playwright';
import GIFEncoder from 'gif-encoder-2';
import { PNG } from 'pngjs';
import { createWriteStream, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'docs', 'images', 'demo.gif');
const WIDTH = 800;
const HEIGHT = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForNoSpinner(page, timeout = 45000) {
  await page.waitForFunction(
    () => document.querySelectorAll('.spinner.large').length === 0,
    { timeout }
  ).catch(() => {});
  await page.waitForTimeout(400);
}

/** Capture a frame (raw RGBA buffer) from the page. */
async function captureFrame(page) {
  const buf = await page.screenshot({ type: 'png' });
  const png = PNG.sync.read(buf);
  return png.data; // raw RGBA
}

/** Add N identical frames at the given delay (ms). */
async function addFrames(encoder, page, count, delayMs) {
  const frame = await captureFrame(page);
  encoder.setDelay(delayMs);
  for (let i = 0; i < count; i++) encoder.addFrame(frame);
}

/** Animate a smooth scroll or just pause for a moment. */
async function pause(encoder, page, ms) {
  const steps = Math.max(1, Math.round(ms / 100));
  for (let i = 0; i < steps; i++) {
    const frame = await captureFrame(page);
    encoder.setDelay(100);
    encoder.addFrame(frame);
    if (i < steps - 1) await page.waitForTimeout(100);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: WIDTH, height: HEIGHT });
await page.goto('http://localhost:3729', { waitUntil: 'networkidle', timeout: 30000 });
await waitForNoSpinner(page);

console.log('Setting up GIF encoder...');
const encoder = new GIFEncoder(WIDTH, HEIGHT, 'neuquant', true);
encoder.setRepeat(0);   // loop forever
encoder.setQuality(20);
encoder.setDelay(100);
encoder.start();

const readStream = encoder.createReadStream();
const writeStream = createWriteStream(OUT_FILE);
readStream.pipe(writeStream);

console.log('Recording...');

// 1. Browse tab — show the installed packages list (hold 2s)
await addFrames(encoder, page, 25, 80);  // 2s

// 2. Type a search query character by character
await page.click('input[placeholder="Search packages..."]');
await pause(encoder, page, 300);
for (const ch of 'serilog') {
  await page.keyboard.type(ch, { delay: 0 });
  await pause(encoder, page, 120);
}
await waitForNoSpinner(page);
await pause(encoder, page, 1200);

// 3. Click the first result to open details
const firstRow = page.locator('package-row').first();
await firstRow.click();
await page.waitForTimeout(600);
await pause(encoder, page, 1500);

// 4. Clear search and go to Updates tab
await page.click('input[placeholder="Search packages..."]');
await page.keyboard.press('Control+a');
await page.keyboard.press('Backspace');
await page.waitForTimeout(300);
await page.click('[role="tab"]:has-text("Updates")');
await waitForNoSpinner(page, 45000);
await pause(encoder, page, 2000);

// 5. Go to Consolidate tab
await page.click('[role="tab"]:has-text("Consolidate")');
await waitForNoSpinner(page, 20000);
await pause(encoder, page, 1500);

// 6. Go to Vulnerabilities tab
await page.click('[role="tab"]:has-text("Vulnerabilities")');
await waitForNoSpinner(page, 20000);
await pause(encoder, page, 1500);

// 7. Back to Browse
await page.click('[role="tab"]:has-text("Browse")');
await waitForNoSpinner(page);
await addFrames(encoder, page, 20, 80);

encoder.finish();

await new Promise((resolve) => writeStream.on('finish', resolve));
await browser.close();

console.log(`Done. GIF saved to ${OUT_FILE}`);
