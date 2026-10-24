# Plan: Native UI Polish

**Status:** IMPLEMENTED (2026-10-24) — see `.ai/completed/native-ui-polish.md`
**Date:** 2026-10-24
**Approved direction:** Native polish (VS Code-native density)
**Mockups:** `docs/design/native.html`, `docs/design/native-*.png`

## Goals

- Make package lists scannable: grouped framework sections, inline TFM chips, clear row hierarchy.
- Give every tab a header (title, count, context) and visible bulk actions.
- Make Updates/Consolidate/Vulnerabilities read as distinct workflows, not flat lists.
- Give the details panel a clear header, version/action area, and meaningful empty state.
- Improve search/filter/toolbar spacing and active-scope visibility.
- Consistent loading, empty, error and focus states.

## Steps

- [ ] Shared design primitives: spacing, row, chip, tabs, toolbar, buttons, section header, state block.
- [ ] Installed: group by shared/netX, inline TFM chips, list header and actions.
- [ ] Updates: group by framework, aligned-latest banner, old→new row, bulk actions.
- [ ] Consolidate: card rows with version lines and target action.
- [ ] Vulnerabilities: severity cards, installed/affected, project chips.
- [ ] Details panel: header, selected version/action, installed-in, framework lines, about, empty state.
- [ ] Project tree + search/filter summary.
- [ ] Accessibility/responsive pass: tab roles, focus, keyboard, narrow widths.
- [ ] Update tests/screenshots/docs and run full verification.

## Acceptance

- Group headers and inline TFM chips are visible in Installed and Updates.
- No badge wraps below a row; rows stay aligned at 1280px and narrow widths.
- Every tab has a header and a clear primary action; empty/error states explain the next step.
- Details panel shows package identity, selected version, framework lines and installed projects.
- `npm run esbuild`, `npm run lint`, `npm test` pass; screenshots regenerated.
