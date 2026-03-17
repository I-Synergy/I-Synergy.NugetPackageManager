# Migrate `.claude/` Content to `.ai/` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all AI context content from `.claude/` to `.ai/` (a vendor-neutral folder), keep only Claude Code config files in `.claude/`, and update `.github/copilot-instructions.md` to share the same `.ai/` content.

**Architecture:** `.claude/` becomes config-only (settings.json + settings.local.json). All documentation, patterns, skills, templates, checklists, plans, progress, and project context live in `.ai/`. Both `CLAUDE.md` and `.github/copilot-instructions.md` reference `.ai/`. Claude Code settings are updated to point to new paths.

**Tech Stack:** File system operations, Markdown, JSON

---

## Affected Files

### Files to stay in `.claude/` (untouched)
- `.claude/settings.json`
- `.claude/settings.local.json`

### Files moving from `.claude/` → `.ai/`
Everything else:
- `.claude/session-context.md` → `.ai/session-context.md`
- `.claude/analysis/` → `.ai/analysis/`
- `.claude/checklists/` → `.ai/checklists/`
- `.claude/completed/` → `.ai/completed/`
- `.claude/patterns/` → `.ai/patterns/`
- `.claude/plans/` → `.ai/plans/`
- `.claude/progress/` → `.ai/progress/`
- `.claude/project/` → `.ai/project/`
- `.claude/reference/` → `.ai/reference/`
- `.claude/skills/` → `.ai/skills/`

### Files to update in-place
- `CLAUDE.md` — all `.claude/` path references → `.ai/`
- `.claude/settings.json` — `plansDirectory` + `additionalDirectories`
- `.github/copilot-instructions.md` — rewrite: `.claude/` → `.ai/`, fix outdated code standards
- `.ai/reference/critical-rules.md` (after move) — Rules 8, 9, 14 reference old `.claude/` paths
- `.ai/checklists/pre-submission.md` (after move) — references `.claude/progress/`
- `.ai/reference/templates/session-handoff.md.txt` (after move) — may reference `.claude/session-context.md`

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

Copy these files from `.claude/` to `.ai/` (exact same relative path, just `.ai/` root):

**Session context:**
- `.claude/session-context.md` → `.ai/session-context.md`

**Checklists:**
- `.claude/checklists/pre-submission.md` → `.ai/checklists/pre-submission.md`

**Patterns (all files):**
- `.claude/patterns/api-patterns.md`
- `.claude/patterns/cqrs-patterns.md`
- `.claude/patterns/microservices.md`
- `.claude/patterns/mvvm.md`
- `.claude/patterns/object-oriented-programming.md`
- `.claude/patterns/service-oriented-architecture.md`
- `.claude/patterns/test-driven-development.md`
- `.claude/patterns/testing-patterns.md`

**Project:**
- `.claude/project/architecture.md`
- `.claude/project/domains.md`
- `.claude/project/preferences.md`
- `.claude/project/README.md`
- `.claude/project/tech-stack.md`

**Reference:**
- `.claude/reference/copilot-integration.md`
- `.claude/reference/critical-rules.md`
- `.claude/reference/forbidden-tech.md`
- `.claude/reference/glossary.md`
- `.claude/reference/naming-conventions.md`
- `.claude/reference/tokens.md`
- All files under `.claude/reference/templates/`

**Skills (all SKILL.md files):**
- All files under `.claude/skills/`

**Step 1:** Use Read + Write to copy each file. Content is identical — no edits at this stage.

---

## Task 3: Update references inside moved files

After copying, update internal `.claude/` path references to `.ai/` in these files:

**`.ai/reference/critical-rules.md`** — update Rule 8, 9, 14:
- `CORRECT:   .claude/progress/task-progress.md` → `.ai/progress/task-progress.md`
- `WRONG:     ~/.claude/progress/task-progress.md` (keep — still wrong)
- `WRONG:     /other/solution/.claude/progress/task-progress.md` (keep — still wrong)
- `.claude/session-context.md` → `.ai/session-context.md`
- `.claude/plans/2026-02-28-feature-name.md` → `.ai/plans/2026-02-28-feature-name.md`
- `plansDirectory` in `.claude/settings.json` note → keep accurate

**`.ai/checklists/pre-submission.md`** — update:
- `Progress file in correct location (\`.claude/progress/\`)` → `.ai/progress/`
- `On completion, moved to \`.claude/completed/\`` → `.ai/completed/`

**`.ai/reference/templates/session-handoff.md.txt`** — update any `.claude/` references.

**Grep check:** After edits, search `.ai/` for any remaining `.claude/` references to catch stragglers.

---

## Task 4: Update `CLAUDE.md`

Replace ALL `.claude/` path references with `.ai/` **except**:
- `.claude/settings.json` — this file stays in `.claude/`; keep the reference accurate

Key replacements (use `replace_all` where appropriate):
- `\.claude/session-context\.md` → `.ai/session-context.md`
- `\.claude/progress/` → `.ai/progress/`
- `\.claude/completed/` → `.ai/completed/`
- `\.claude/plans/` → `.ai/plans/`
- `\.claude/checklists/` → `.ai/checklists/`
- `\.claude/reference/` → `.ai/reference/`
- `\.claude/patterns/` → `.ai/patterns/`
- `\.claude/skills/` → `.ai/skills/`
- `\.claude/project/` → `.ai/project/`

Also update the **Core Operational Rules** section which currently says:
> "Read session context first: `.claude/session-context.md`"

And update the **Task Execution Protocol** progress file paths.

**Final grep check:** `grep -r "\.claude/" CLAUDE.md` — should only return hits for `.claude/settings.json`.

---

## Task 5: Update `settings.json`

**File:** `.claude/settings.json`

Two changes:

1. `plansDirectory`: `"./.claude/plans"` → `"./.ai/plans"`

2. `additionalDirectories`: replace all `.claude/` content dirs with `.ai/` equivalents:
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

The current file is outdated (references old extension methods, sparse, `.claude/` paths). Rewrite to:

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

## Task 7: Delete content from `.claude/`

Remove everything from `.claude/` except `settings.json` and `settings.local.json`:

**Directories to delete:**
- `.claude/analysis/`
- `.claude/checklists/`
- `.claude/completed/`
- `.claude/patterns/`
- `.claude/plans/`
- `.claude/progress/`
- `.claude/project/`
- `.claude/reference/`
- `.claude/skills/`

**File to delete:**
- `.claude/session-context.md`

Use `Remove-Item -Recurse` (PowerShell) for directories.

---

## Task 8: Verify

**Step 1:** Check `.claude/` contains only expected files:
```powershell
Get-ChildItem .claude/ -Recurse | Select-Object FullName
```
Expected: only `settings.json` (and optionally `settings.local.json`)

**Step 2:** Check no `.claude/` content refs remain in CLAUDE.md:
```powershell
Select-String -Path CLAUDE.md -Pattern "\.claude/" | Where-Object { $_ -notmatch "settings\.json" }
```
Expected: 0 results

**Step 3:** Check no `.claude/` content refs remain in `.ai/` files:
```powershell
Get-ChildItem .ai/ -Recurse -File | Select-String -Pattern "\.claude/" | Select-Object -First 20
```
Expected: 0 results (or only references to `settings.json` as a known exception)

**Step 4:** Verify settings.json plansDirectory:
```powershell
Get-Content .claude/settings.json
```
Expected: `"plansDirectory": "./.ai/plans"`

**Step 5:** Confirm `.ai/` structure mirrors old `.claude/`:
```powershell
Get-ChildItem .ai/ -Recurse | Select-Object FullName | Measure-Object
```
