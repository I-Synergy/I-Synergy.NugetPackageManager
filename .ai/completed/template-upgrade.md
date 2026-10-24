# AI Template Upgrade (.claude → .ai)

Status: DONE
Started: 2026-10-24
Completed: 2026-10-24

## Steps
- [x] Migrate `.claude/` content to `.ai/` with the template migration script
- [x] Apply template-owned files: agents, skills, patterns, reference, checklists, scripts, tests
- [x] Adapt `AGENTS.md` to this TypeScript/VS Code extension repository
- [x] Keep `CLAUDE.md` as the project-specific engineering guide and point it at `AGENTS.md`
- [x] Update `.github/copilot-instructions.md` with the `.ai/` session-memory convention
- [x] Merge `.claude/settings.json` hooks and remove the .NET build hook
- [x] Add `.gitignore` rules for junctions and scratch artifacts
- [x] Run the template validation suite (11/11 passed)

## Notes
- Canonical context is now `.ai/`; platform folders are junctions created by
  `.ai/scripts/sync-skills.py`.
- Project-owned content preserved: `.ai/session-context.md`, `.ai/project/`, `.ai/plans/`,
  `.ai/progress/`, `.ai/completed/`, `.ai/analysis/`, `.github/copilot-instructions.md`.
- Template upgrades use `.ai/scripts/upgrade-template.py`.
