# Plan: Full-page marketplace UI

**Status:** APPROVED — implementing
**Date:** 2026-10-24

## Approved direction

- Full-page NuGet UI in an editor tab.
- Activity-bar icon opens that tab directly; the sidebar container is a compact launcher.
- Apply the marketplace visual design across all screens and tabs.

## Steps

1. Refactor the host webview into a `WebviewPanel` manager (singleton, restore, commands).
2. Replace the panel-area view with an activity-bar launcher view that opens the tab.
3. Update `package.json` contributions and activation events.
4. Port marketplace styling to shared styles, package rows, tabs, headers, trees and details.
5. Apply marketplace card layout to Installed, Browse, Updates, Consolidate and Vulnerabilities.
6. Verify build/lint/tests and capture new full-page screenshots.
7. Repackage and install the VSIX.

## Acceptance

- Clicking the NuGet activity-bar icon opens the UI in a full editor tab.
- `NuGet Package Manager: Open Packages` opens/reveals the same tab.
- No NuGet view remains in the terminal/panel area.
- All screens use the marketplace card/rounded visual language.
- `npm run esbuild`, `npm run lint`, `npm test` pass.
