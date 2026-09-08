---
name: skill-management
description: Create, restructure, or review repository-local skills. Use before changing `.agents/skills/**`, skill frontmatter, activation behavior, or bundled references, templates, scripts, and assets.
user-invocable: false
---

# Skill Management

Edit skills under `.agents/skills/<name>/`. Do not edit through `.claude/skills` or `.pi/skills`.

Every skill requires a `SKILL.md`. Its Markdown body has no fixed structure. Choose the sections that make the skill easiest to use.

Use this frontmatter:

- `name`: Required. Use lowercase letters, numbers, and hyphens. Match the skill directory.
- `description`: Required. State what the skill does and when it activates. Keep it short because clients load it before activation.
- `user-invocable: false`: Optional. Hide a skill that users should not invoke directly.
- `disable-model-invocation: true`: Optional. Require explicit user invocation.
- `argument-hint`: Optional. Describe arguments for manual invocation.

Do not add other frontmatter fields unless the user requests them. Do not use `verified` or `anchors` in skill frontmatter. Remove them when editing an existing skill. Invocation arguments are runtime input, not an `arguments` frontmatter field.

Keep the common path in `SKILL.md`. Add bundled files only when they reduce context or make execution more reliable:

- `references/`: Conditional details, variants, specifications, and long examples.
- `templates/`: Reusable output structures that the agent fills or copies.
- `scripts/`: Deterministic or repeated operations. Keep scripts small and task-specific.
- `assets/`: Static schemas, images, data, or files used as input.

Use another folder when its name describes the content more clearly. Do not create empty folders or human-facing README files.

Tell the agent exactly when to read or run each bundled file. Reference it with `<skill-dir>/...`. Avoid chains of references.

After a change:

1. Confirm that `name` matches the skill directory.
2. Confirm that every bundled-file reference resolves.
3. Run safe script checks when the skill includes scripts.
4. Run `git diff --check`.
