# Consolidation — respect framework lines

Status: DONE
Started: 2026-10-24
Completed: 2026-10-24
Plan: `.ai/plans/consolidate-multi-framework.md`

## Steps
- [x] Host: key inconsistencies by package + condition + target framework.
- [x] Host: keep the original package ID with the group; no string splitting.
- [x] UI: group consolidate cards by Shared/netX and show framework headers.
- [x] UI: send only the selected framework line's projects, with its condition.
- [x] UI: remove only the consolidated `(Id, condition, framework)` row.
- [x] UI: run "Consolidate all" sequentially and only for visible cards.
- [x] Host: refuse blanket `Scope: "all"`/`"first"` for framework-scoped packages.
- [x] Tests: host write scope per condition; UI grouping and request scope.
- [x] Verify: build, lint, full test suite.

## Notes
- New tests: `keeps framework lines separate when grouping inconsistencies`,
  `consolidates only the requested framework line`,
  `refuses a blanket consolidation of a framework-scoped package`,
  `groups cards by framework line`,
  `sends only the selected framework line when a card contains two lines`,
  `keeps same-condition cards for other frameworks`.
- `npm test`: **321 passing**.
