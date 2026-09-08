---
name: bugfix
description: Use this skill when the user presents a bug to fix. Do not use it for issues encountered while implementing a feature or executing a plan.
---

Fix bugs at their root cause. Use test-driven development (TDD).

## Important rules

- Avoid quick patches. Resolve the underlying system problem cleanly.
- A bad bugfix makes the system more complicated. Indicators include:
  - New special cases
  - New conditions in multiple places
  - Questionable workarounds
- A good bugfix makes the system simpler. It often:
  - Removes special cases
  - Introduces a clean abstraction
  - Improves the understanding of the problem space

## Workflow

1. Analyze the codebase and all relevant areas.
2. Define one to five hypotheses about the root cause.
3. Try to prove each hypothesis:
   - Add instrumentation.
   - Run tests or focused ad hoc code.
   - Inspect dependencies when necessary.
   - If required tools or access are unavailable, ask the user to run the necessary command or test.
4. Write an automated test that reproduces the issue. Confirm that it fails before you change the implementation.
5. Fix the issue at its root cause.
6. Confirm that the new test passes.
7. Run the relevant repository checks.
8. Review the quality of the fix:
   - Confirm that it integrates with the existing system.
   - Reconsider the affected abstractions or module boundaries when the fix exposes a design problem.
   - Act on relevant findings.
   - Repeat verification after further changes.
9. Summarize the root cause, fix, and verification for the user. Use a stack trace or before-and-after comparison when it makes the explanation clearer.
