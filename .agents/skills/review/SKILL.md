---
name: review
description: Review changes for correctness, repository standards, and requirements. Fix safe, local findings and report all results. Use when the user asks for a code review or final change review.
---

# Review

Review the requested change. Do not review unrelated existing code.

## Prepare the review

1. Determine the scope:
   - Use the changes and comparison the user requested.
   - Possible scopes could be working tree changes, a branch or pull request, a commit, tag, files, a GitHub/GitLab issue or similar.
   - If the scope is missing or unclear, ask before starting the review.

2. Decide how to work:
   - Default: **In-context review**. Review all perspectives in the current session.
   - Use sequential or parallel subagents only when the user requests or approves them. In this mode, follow the [subagent review guide](references/subagent-reviews.md).
   - If using available subagents would improve the review, explain why and ask the user whether to use them or continue in the current session.
   - Do not use subagents without the users approval, the user can always override a recommendation.

3. Confirm the comparison:
   - Validate supplied Git references and inspect the working-tree state.
   - State the selected scope and base. Distinguish exact and merge-base comparisons. Include uncommitted files only when they are in scope.
   - If there are no changes in scope, report this and stop.

4. Gather the review sources:
   - Read repository instructions and development guidance that apply to the changed files.
   - Use user-supplied requirements first, then sources linked to the change.
   - If requirements are unclear, ask for clarification. If none are available, continue with the other perspectives and report this limitation.

## Review the change

1. Read the complete in-scope diff and enough surrounding code to assess its effects.
2. Review each perspective:
   - **Correctness:** Check that the change works correctly and securely without breaking existing behavior. Check error handling, cleanup, and tests.
   - **Standards:** Check code quality and and maintainability and how well the code style matches the existing style. Do so using the repository rules. Read the [code-smell guide](references/code-smells.md) for design checks.
   - **Requirements:** Check for missing, partial or incorrect behaviour or scope extensions or conflicts between the implementation and the requested change.
3. Consolidate findings into one list, ranked by impact:
   - Merge duplicates across perspectives and reviewers. Keep the relevant category labels.
   - Give each finding a unique sequential identifier, such as `F1` and `F2`.
   - Continue from the highest identifier when later review work finds more issues.
   - Do not reuse an identifier.
   - Include severity, file path and location, evidence, concrete failure mode or cost, and a recommended correction.
   - Cite the applicable rule or requirement for standards and requirements findings. For correctness findings, show the failing behavior or explain the code path that causes it.

## Fix and verify

1. Fix a finding when the correction is safe, local, and within the requested scope.
2. Report all other findings without changing the code. Explain why each remains unresolved. If safety or scope is uncertain, report the finding instead of applying a fix.
3. Follow repository guidance for regression tests and verification. Run focused checks for each fix and the required final checks for the affected change types.
4. Re-read the resulting diff. Check that fixes resolve their findings and introduce no unrelated changes or regressions.
5. Create a commit only when the user requests one.

## Report

Present a concise, structured summary:

- **Scope and coverage:** What was reviewed, the comparison base, and any unavailable requirements or review limitations.
- **Fixed findings:** Findings fixed during the review, identifid by their finding numbers. Also include their impact, location, what changed and the verification results
- **Remaining findings:** Findings that remain and why, ranked by impact and identified by their finding numbers. Also include evidence, recommended corrections, and reasons they were not fixed.
- **Checks:** Commands run and their results. List checks not run and explain why.

State directly when there are no findings or no findings remain. Report every change made during the review.
