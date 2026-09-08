---
name: comment-writing
description: Write or review code comments and documentation comments. Use when adding, changing, or evaluating comments, TODOs, or migration rationale.
---

# Comment Writing

Explain **why**, not **what**. If the code is clear, do not comment it.

## Guidance

- Use ASD-STE100 Simplified Technical English.
- Prefer clearer names or a small function over an explanatory comment.
- Comment non-obvious constraints, ordering, compatibility, or failure handling.
- Use documentation comments for contracts the signature does not show, such as side effects, exceptions, or invariants.
- Describe current behavior, not implementation history.
- Do not add a comment if the code is self-explanatory.
- Placeholder comments are permitted in templates and scaffolds when they mark where generated or user-authored code belongs.
- Remove or replace placeholder comments when the template is instantiated.
- Do not repeat the same explanatory comment in multiple places.

## Examples

Explain a constraint:

```ts
// Bad: Set the timeout to 30 seconds.
const timeout = 30_000;

// Good: Stay below the gateway's 60-second idle timeout.
const timeout = 30_000;
```

Do not repeat the signature in a documentation comment:

```ts
/** Return the resource only when the current user can view it. */
function findResource(resourceId: string): Resource | undefined;
```

Make TODOs actionable:

```ts
// Bad: TODO: Clean this up.
// Good: TODO(#123): Remove this after all images use schema version 2.
```

Record migration constraints, not implementation history:

```ts
// Keep this optional while the previous application version can write records.
```

Keep comments close to the code. Update or remove stale comments. Delete commented-out code. Use stable issue identifiers instead of temporary plans, branches, or local paths.
