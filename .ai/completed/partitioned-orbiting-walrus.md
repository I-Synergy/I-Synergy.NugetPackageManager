# Migrate `.claude/` Content to `.ai/` Implementation Plan

**Status:** DONE (2026-10-24) — executed as part of the AI template upgrade.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all AI context content from `.ai/` to `.ai/` (a vendor-neutral folder), keep only Claude Code config files in `.ai/`, and update `.github/copilot-instructions.md` to share the same `.ai/` content.

**Architecture:** `.ai/` becomes config-only (settings.json + settings.local.json). All documentation, patterns, skills, templates, checklists, plans, progress, and project context live in `.ai/`. Both `CLAUDE.md` and `.github/copilot-instructions.md` reference `.ai/`. Claude Code settings are updated to point to new paths.

**Tech Stack:** File system operations, Markdown, JSON

---

## Affected Files

### Files to stay in `.ai/` (untouched)
- `.claude/settings.json`
- `.claude/settings.local.json`

### Files moving from `.ai/` → `.ai/`
Everything else:
- `.ai/session-context.md` → `.ai/session-context.md`
- `.ai/analysis/` → `.ai/analysis/`
- `.ai/checklists/` → `.ai/checklists/`
- `.ai/completed/` → `.ai/completed/`
- `.ai/patterns/` → `.ai/patterns/`
- `.ai/plans/` → `.ai/plans/`
- `.ai/progress/` → `.ai/progress/`
- `.ai/project/` → `.ai/project/`
- `.ai/reference/` → `.ai/reference/`
- `.ai/skills/` → `.ai/skills/`

### Files to update in-place
- `CLAUDE.md` — all `.ai/` path references → `.ai/`
- `.claude/settings.json` — `plansDirectory` + `additionalDirectories`
- `.github/copilot-instructions.md` — rewrite: `.ai/` → `.ai/`, fix outdated code standards
- `.ai/reference/critical-rules.md` (after move) — Rules 8, 9, 14 reference old `.ai/` paths
- `.ai/checklists/pre-submission.md` (after move) — references `.ai/progress/`
- `.ai/reference/templates/session-handoff.md.txt` (after move) — may reference `.ai/session-context.md`

---

## Task 1: Create `.ai/` directory structure

**Files:**
- Create: `.ai/analysis/.gitkeep`
- Create: `.ai/checklists/.gitkeep`
- Create: `.ai/completed/.gitkeep`
- Create: `.ai/patterns/.gitkeep`
- Create: `.ai/plans/.gitkeep`
- Create: `.ai/progress/.gitkeep`
- Create: `.ai/project/.gitkeep`
- Create: `.ai/reference/.gitkeep`
- Create: `.ai/reference/templates/.gitkeep`
- Create: `.ai/skills/.gitkeep`

**Step 1:** Create all placeholder files so the directory structure exists before copying content.

---

## Task 2: Copy content files to `.ai/`

Copy these files from `.ai/` to `.ai/` (exact same relative path, just `.ai/` root):

**Session context:**
- `.ai/session-context.md` → `.ai/session-context.md`

**Checklists:**
- `.ai/checklists/pre-submission.md` → `.ai/checklists/pre-submission.md`

**Patterns (all files):**
- `.ai/patterns/api-patterns.md`
- `.ai/patterns/cqrs-patterns.md`
- `.ai/patterns/microservices.md`
- `.ai/patterns/mvvm.md`
- `.ai/patterns/object-oriented-programming.md`
- `.ai/patterns/service-oriented-architecture.md`
- `.ai/patterns/test-driven-development.md`
- `.ai/patterns/testing-patterns.md`

**Project:**
- `.ai/project/architecture.md`
- `.ai/project/domains.md`
- `.ai/project/preferences.md`
- `.ai/project/README.md`
- `.ai/project/tech-stack.md`

**Reference:**
- `.ai/reference/copilot-integration.md`
- `.ai/reference/critical-rules.md`
- `.ai/reference/forbidden-tech.md`
- `.ai/reference/glossary.md`
- `.ai/reference/naming-conventions.md`
- `.ai/reference/tokens.md`
- All files under `.ai/reference/templates/`

**Skills (all SKILL.md files):**
- All files under `.ai/skills/`

**Step 1:** Use Read + Write to copy each file. Content is identical — no edits at this stage.

---

## Task 3: Update references inside moved files

After copying, update internal `.ai/` path references to `.ai/` in these files:

**`.ai/reference/critical-rules.md`** — update Rule 8, 9, 14:
- `CORRECT:   .ai/progress/task-progress.md` → `.ai/progress/task-progress.md`
- `WRONG:     ~/.claude/progress/task-progress.md` (keep — still wrong)
- `WRONG:     /other/solution/.ai/progress/task-progress.md` (keep — still wrong)
- `.ai/session-context.md` → `.ai/session-context.md`
- `.ai/plans/2026-02-28-feature-name.md` → `.ai/plans/2026-02-28-feature-name.md`
- `plansDirectory` in `.claude/settings.json` note → keep accurate

**`.ai/checklists/pre-submission.md`** — update:
- `Progress file in correct location (\`.ai/progress/\`)` → `.ai/progress/`
- `On completion, moved to \`.ai/completed/\`` → `.ai/completed/`

**`.ai/reference/templates/session-handoff.md.txt`** — update any `.ai/` references.

**Grep check:** After edits, search `.ai/` for any remaining `.ai/` references to catch stragglers.

---

## Task 4: Update `CLAUDE.md`

Replace ALL `.ai/` path references with `.ai/` **except**:
- `.claude/settings.json` — this file stays in `.ai/`; keep the reference accurate

Key replacements (use `replace_all` where appropriate):
- `\.ai/session-context\.md` → `.ai/session-context.md`
- `\.ai/progress/` → `.ai/progress/`
- `\.ai/completed/` → `.ai/completed/`
- `\.ai/plans/` → `.ai/plans/`
- `\.ai/checklists/` → `.ai/checklists/`
- `\.ai/reference/` → `.ai/reference/`
- `\.ai/patterns/` → `.ai/patterns/`
- `\.ai/skills/` → `.ai/skills/`
- `\.ai/project/` → `.ai/project/`

Also update the **Core Operational Rules** section which currently says:
> "Read session context first: `.ai/session-context.md`"

And update the **Task Execution Protocol** progress file paths.

**Final grep check:** `grep -r "\.ai/" CLAUDE.md` — should only return hits for `.claude/settings.json`.

---

## Task 5: Update `settings.json`

**File:** `.claude/settings.json`

Two changes:

1. `plansDirectory`: `"./.ai/plans"` → `"./.ai/plans"`

2. `additionalDirectories`: replace all `.ai/` content dirs with `.ai/` equivalents:
```json
"additionalDirectories": [
  "./.claude",
  "./.ai",
  "./.ai/analysis",
  "./.ai/checklists",
  "./.ai/completed",
  "./.ai/patterns",
  "./.ai/plans",
  "./.ai/progress",
  "./.ai/project",
  "./.ai/reference",
  "./.ai/skills"
]
```
Keep `./.claude` so Claude Code can still read `settings.json` itself.

---

## Task 6: Rewrite `.github/copilot-instructions.md`

The current file is outdated (references old extension methods, sparse, `.ai/` paths). Rewrite to:

1. Point all paths to `.ai/`
2. Fix code standards (FirstOrDefaultAsync, no extension methods, no `.Update()`)
3. Add more complete guidance from our updated critical rules

New content structure:
```markdown
# GitHub Copilot Instructions

## Project Context
[Brief architecture summary]

## Critical Rules
See `.ai/reference/critical-rules.md` for complete rules.

Key rules (violations cause bugs):
- Commands use individual parameters (NOT model objects)
- Data access: EF Core primitives on named DbSet properties (`FirstOrDefaultAsync`, `Add`, `Remove`, `SaveChangesAsync`)
- Delete: `FirstOrDefaultAsync` + `Remove` + check `rowsAffected > 0`
- Update: `FirstOrDefaultAsync` + mutate properties + `SaveChangesAsync` (NO `.Update()` call — change tracker handles it)
- Mapping: Mapster only (`entity.Adapt<T>()`, `ProjectToType<T>()`)

## Architecture
[Clean Architecture layers]

## Forbidden Technologies
See `.ai/reference/forbidden-tech.md`

## Patterns & Templates
- CQRS: `.ai/patterns/cqrs-patterns.md`
- API: `.ai/patterns/api-patterns.md`
- Testing: `.ai/patterns/testing-patterns.md`
- Templates: `.ai/reference/templates/`

## Token Replacements
See `.ai/reference/tokens.md`
```

---

## Task 7: Delete content from `.ai/`

Remove everything from `.ai/` except `settings.json` and `settings.local.json`:

**Directories to delete:**
- `.ai/analysis/`
- `.ai/checklists/`
- `.ai/completed/`
- `.ai/patterns/`
- `.ai/plans/`
- `.ai/progress/`
- `.ai/project/`
- `.ai/reference/`
- `.ai/skills/`

**File to delete:**
- `.ai/session-context.md`

Use `Remove-Item -Recurse` (PowerShell) for directories.

---

## Task 8: Verify

**Step 1:** Check `.ai/` contains only expected files:
```powershell
Get-ChildItem .ai/ -Recurse | Select-Object FullName
```
Expected: only `settings.json` (and optionally `settings.local.json`)

**Step 2:** Check no `.ai/` content refs remain in CLAUDE.md:
```powershell
Select-String -Path CLAUDE.md -Pattern "\.ai/" | Where-Object { $_ -notmatch "settings\.json" }
```
Expected: 0 results

**Step 3:** Check no `.ai/` content refs remain in `.ai/` files:
```powershell
Get-ChildItem .ai/ -Recurse -File | Select-String -Pattern "\.ai/" | Select-Object -First 20
```
Expected: 0 results (or only references to `settings.json` as a known exception)

**Step 4:** Verify settings.json plansDirectory:
```powershell
Get-Content .claude/settings.json
```
Expected: `"plansDirectory": "./.ai/plans"`

**Step 5:** Confirm `.ai/` structure mirrors old `.ai/`:
```powershell
Get-ChildItem .ai/ -Recurse | Select-Object FullName | Measure-Object
```
