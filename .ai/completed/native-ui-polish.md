# Native UI Polish

Status: DONE
Started: 2026-10-24
Completed: 2026-10-24
Plan: `.ai/plans/native-ui-polish.md`
Designs: `docs/design/native.html`, `docs/design/actual-*.png`

## Steps
- [x] Shared design primitives (spacing, tabs, buttons, list headers, chips, state blocks)
- [x] Installed grouping + inline TFM chips
- [x] Updates grouping + aligned-latest banner + bulk actions
- [x] Consolidate cards
- [x] Vulnerabilities cards
- [x] Details panel header + version area + empty state
- [x] Project tree header/metadata + selected-scope summary
- [x] Search/toolbar and tab polish
- [x] Tests and screenshots

## Verification
- `npm run esbuild` — clean
- `npm run lint` — clean
- `npm test` — 315 passing
- Actual UI captured at 1280×820 in `docs/images/screenshot-*.png`
- Design comparisons in `docs/design/` (native and marketplace)

## Notes
- Chose Native polish after side-by-side review.
- Installed and Updates now group by Shared/netX with inline TFM chips.
- Every tab has a header, context count and primary action.
- Details panel shows a clear empty state and a package header when selected.
- Marketplace mockups are retained in `docs/design/` for future reference.
