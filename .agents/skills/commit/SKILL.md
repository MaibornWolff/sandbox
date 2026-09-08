---
name: commit
description: Commit changes in this project. Use when the user asks to commit, create a commit, or save their work to git. Handles running checks, writing the commit message, and staging files.
---

# Commit Skill

## Rules

- Format: **conventional commits, no scope** — `type: short description`
- Valid types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`
- Subject line: imperative, lowercase, no period, max ~72 chars
- Body: describe **what** was built/changed, not how — think changelog entry
- You MUST run `bun check` before committing. Never use `--no-verify`.
- Never commit if `bun check` fails.

## Steps

1. Run `bun check` — fix any errors before proceeding
2. Review staged/unstaged changes: `git status` + `git diff` + `git diff --cached`
3. Stage relevant files: `git add <files>` (be intentional, avoid `git add .` for unrelated changes)
4. Write and create the commit

## Commit Message Format

```
type: short subject (what changed, imperative)

What was added or changed, written like a changelog entry.
Focus on the user-facing or developer-facing outcome.
Multiple lines are fine for larger changes.
```

## Examples

**Simple fix:**
```
fix: prevent crash when config file is missing

Config loading now falls back to defaults when the file does not exist,
instead of throwing an unhandled exception.
```

**New feature:**
```
feat: add per-project volume persistence

Projects now get an isolated data volume under {data}/{project-slug}/.
Data survives container restarts and is separate from the global volume.
```

**Refactor:**
```
refactor: extract path helpers into utils/paths.ts

getSandboxConfigDir and getDataHomeDir are now shared utilities used by
config loading, docker setup, and state management.
```

**New command:**
````
feat: add `sandbox prune` command to remove unused volumes

Volumes that are no longer linked to any project can now be removed
in one step:

```
$ sandbox prune
Found 3 unused volumes (2.1 GB):
  - myapp-2024-01 (800 MB)
  - test-project (1.1 GB)
  - old-demo (200 MB)
Remove all? (y/N) y
Removed 3 volumes, freed 2.1 GB
```

Run with --dry-run to preview without deleting.
````

**Multiple changes in one commit:**
```
feat: add locale support for date and number formatting

- Dates now render according to the user's system locale
- Numbers use locale-aware separators (e.g. 1.000,00 vs 1,000.00)
- Locale is read from LANG env var with a fallback to en-US
```

## What NOT to write in the body

- "Used X library to implement Y" — that's how, not what
- "Refactored the function to use a loop" — still how
- "Updated imports" — too low-level, skip unless it's the whole point

Write the body as if describing the change to someone reading a changelog.
