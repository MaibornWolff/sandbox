---
name: review
description: Review the current changes against repository guidance, fix safe findings, run relevant checks, and report fixed and remaining findings. Use when the user asks for a code review or final change review.
---

# Review

Review the requested change. Do not review unrelated existing code.

## Workflow

1. Inspect the working tree and determine the comparison base.
2. Read the instructions and development guidance that apply to the changed files.
3. Review the complete diff for correctness, regressions, security, maintainability, and missing tests.
4. Rank findings by impact.
   - Give each finding a unique sequential identifier, such as `F1` and `F2`.
   - Continue from the highest identifier when later review work finds more issues.
   - Do not reuse an identifier.
   - Include file paths and explain the concrete failure mode.
   - Recommend a fix for every finding.
5. Fix a finding when the correction is safe, local, and within the requested scope.
6. Do not make speculative redesigns or hide unresolved findings.
7. Run the narrowest checks that cover each fix. Run the repository-required final checks when practical.
8. Re-read the resulting diff.
9. Report:
   - Findings fixed during the review, identified by their finding numbers
   - Findings that remain and why, identified by their finding numbers and recommended fixes
   - Checks run and their results
   - Checks not run and their reason

If there are no findings, say so directly. Do not create a commit unless the user requests one.
