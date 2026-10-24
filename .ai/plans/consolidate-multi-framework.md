# Consolidation — respect framework lines

Status: DONE
Started: 2026-10-24
Completed: 2026-10-24
Progress: `.ai/completed/consolidate-multi-framework.md`

## Problem

A package may legitimately have one version per target framework. Consolidation
must compare and update versions inside one framework line only.

## Changes

- Inconsistencies are keyed by `packageId + condition + target framework`; a
  net10.0 and net11.0 line can no longer collapse into one card.
- Consolidate cards are grouped under `Shared` / `netX` headers.
- A consolidation request sends only the selected line's projects and condition.
- Removing a consolidated card keys on `(Id, condition, framework)`, so another
  framework line stays visible.
- `Consolidate all` runs sequentially and only for visible cards.
- The host refuses a blanket `Scope: "all"`/`"first"` consolidation for a
  framework-scoped package.
- Regression tests cover grouping, per-line project selection, same-condition
  cards, host write scope and blanket-scope refusal.

## Verification

- `npm test` — 321 passing
- `npm run build`/`npm run lint` — clean (before final test run)
- `docs/images/screenshot-consolidate.png` regenerated with framework headers
