---
name: create-pr
description: Create a pull request from the local fork. Use when the user asks to create or open a pull request.
---

# Create a Pull Request

1. Identify the issue from the conversation, branch, or commits. Confirm the issue with the user. If it is unclear, ask the user for the issue number or URL.
2. Inspect staged, unstaged, and untracked changes. If any uncomitted changes remain that are relevant to the pull request, tell the user which files are affected and stop. Ask the user when the scope of a change is unclear.
3. Identify the current branch, the fork remote, and the default base branch of `MaibornWolff/sandbox`. Compare the branch with that base and review the commits and diff. Stop if the branch or target is unclear, or if the branch has no changes to propose.
4. Read the [pull request template](../../../.github/pull_request_template.md). Check every validation item against the changes and available evidence. Run applicable checks when necessary. Record the results and explain items that could not be verified. Do not mark an item complete without evidence. If an applicable check fails, stop and report the failure.
5. Draft the title and full pull request body from the template. Present the pul request title and text, target repository, base branch, head branch, title, body, and validation results to the user. Ask for confirmation before creating the pull request.
6. After confirmation, create the pull request against `MaibornWolff/sandbox` from the fork branch. If the branch must be pushed, get explicit confirmation for that push before pushing. Report the pull request URL. If creation fails, report the error.
