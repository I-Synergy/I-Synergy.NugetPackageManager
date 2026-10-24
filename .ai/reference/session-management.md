# Session Management

## Shared Memory: `.ai/session-context.md`

`.ai/session-context.md` is the shared memory for every client. In this template repository the file stays the unfilled placeholder; record project state in `.ai/progress/` and `.ai/completed/` instead.

**Reading (every session):** Before starting any work, read `.ai/session-context.md` first. On Claude Code, the `SessionStart` hook prints it automatically (skipped while it is still the placeholder). On GitHub Copilot and Reasonix Code, reading is an instruction only — they have no hook mechanism.

**Writing (end of session):** Before your final reply of any session that changed project state, update the file using `.ai/reference/templates/session-handoff.md.txt`, set Written By to your client name (Claude Code, GitHub Copilot, or Reasonix Code), update sections in place, and never overwrite another client's entries.

## Every Session

1. Read `.ai/session-context.md` (or let the hook print it)
2. Read `.ai/completed/` (relevant tasks from prior sessions)
3. Work with real-time progress reporting to `.ai/progress/`
4. Before ending any session that changed project state, write structured handoff using `.ai/reference/templates/session-handoff.md.txt`

## Session Switching

Start a new session when:
- Context nears the model's limit (session context grows large enough that the next task won't fit without compaction)
- Switching projects or domains
- Changing work types
- Session reached completion

## Session Handoff

Before ending a session that changed project state: Use `.ai/reference/templates/session-handoff.md.txt` as your template. Write to `.ai/session-context.md`. Always set **Written By: [assistant name]** in the handoff (e.g. "Claude Code", "GitHub Copilot", or "Reasonix Code").

The session context is shared — all clients (Claude Code, GitHub Copilot, Reasonix Code) read and write the same `.ai/session-context.md`. When picking up after another client's session:
- Read `.ai/session-context.md` for full context
- Check `.ai/progress/` for in-progress tasks
- Check `.ai/plans/` for approved plans not yet executed
- No re-setup needed — all context is in `.ai/`

## Blocked Paths (Do Not Retry)

Record empirically-disproven approaches in `.ai/session-context.md` under the `Blocked Paths (Do Not Retry)` section, with a "Do NOT re-attempt" note and the reason:

```markdown
### {Approach name}

- **Do NOT re-attempt:** {what was tried}
- **Reason:** {why it is a dead end}
- **Use instead:** {the working alternative}
```

Why this matters: a dead end discovered in one session gets rediscovered — and its time re-wasted — in a later session unless it is written down. Future sessions read `.ai/session-context.md` first and skip the blocked path.

## Progress File Status

- `IN PROGRESS` — active work
- `DONE` — completed; move the file to `.ai/completed/`
- `SUPERSEDED` — the approach in this progress file was replaced by a later approach. Mark it (do not delete it) so future sessions know why the earlier approach was abandoned.
