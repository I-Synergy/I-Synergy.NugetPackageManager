#!/usr/bin/env node

// Local mirror of the GitHub Actions quality gate (.github/workflows/quality-gate.yml).
// Run this before committing so a red pipeline is fixed locally, not after the push.
//
// Usage: node tools/quality-gate.mjs [--coverage] [--fix] [--skip-build] [--skip-tests] [--help]
//
// Steps: build -> lint (ESLint + SonarJS) -> type check -> compile tests -> tests -> npm audit.
// With --coverage the test step writes coverage/lcov.info for the SonarCloud scan in CI.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const isWindows = process.platform === "win32";

const args = new Set(process.argv.slice(2));
const help = args.has("--help") || args.has("-h");
const coverage = args.has("--coverage");
const fix = args.has("--fix");
const skipBuild = args.has("--skip-build");
const skipTests = args.has("--skip-tests");

if (help) {
  console.log(`Usage: node tools/quality-gate.mjs [options]

  --coverage    collect coverage/lcov.info while running the test suite
  --fix         let ESLint apply its automatic fixes before the gate runs
  --skip-build  skip the esbuild bundle step
  --skip-tests  skip test compilation and execution
  --help        show this message`);
  process.exit(0);
}

function run(label, command, commandArgs) {
  console.log(`\n=== ${label} ===`);
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    // npm/npx are .cmd shims on Windows and must be launched through the shell.
    shell: isWindows,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.error) {
    console.error(`\n✗ ${label} failed to start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${result.status ?? "unknown"}) after ${seconds}s`);
    return false;
  }
  console.log(`✓ ${label} (${seconds}s)`);
  return true;
}

if (fix) {
  console.log("Applying ESLint automatic fixes…");
  run("Lint fix", "npm", ["run", "lint:fix"]);
}

const steps = [];

if (!skipBuild) {
  steps.push(["Build", "npm", ["run", "esbuild"]]);
}

steps.push(["Lint + SonarJS", "npm", ["run", "lint"]]);
steps.push(["Type check", "npx", ["--no-install", "tsc", "--noEmit"]]);

if (!skipTests) {
  steps.push(["Compile tests", "npm", ["run", "test-compile"]]);
  steps.push([
    coverage ? "Tests with coverage" : "Tests",
    "npm",
    ["run", coverage ? "test:coverage" : "test"],
  ]);
}

steps.push(["Dependency audit", "npm", ["audit", "--audit-level=high"]]);

if (coverage) {
  // A stale report would let SonarCloud score a previous run.
  rmSync(join(ROOT, "coverage"), { recursive: true, force: true });
}

const failed = [];
for (const [label, command, commandArgs] of steps) {
  if (!run(label, command, commandArgs)) {
    failed.push(label);
  }
}

console.log("\n================ QUALITY GATE ================");
if (failed.length === 0) {
  console.log(`PASS — ${steps.length} step(s) succeeded.`);
  if (!coverage) {
    console.log("Tip: run with --coverage to produce coverage/lcov.info for SonarCloud.");
  }
  process.exit(0);
}

console.log(`FAIL — ${failed.length}/${steps.length} step(s) failed:`);
for (const label of failed) {
  console.log(`  - ${label}`);
}
process.exit(1);
