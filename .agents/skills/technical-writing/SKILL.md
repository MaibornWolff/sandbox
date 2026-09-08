---
name: technical-writing
description: Write or review technical documentation, agent instructions, and other non-user-facing text. Use when changing AGENTS.md, skills, architecture documents, README files, and other developer-facing documentation. Do not use for product user-interface copy. Also use for merge request and issue titles or descriptions.
---

# Technical Writing

Make technical documents easy to read.

## Language

- Use ASD-STE100 Simplified Technical English.
- Use simple words and phrases when they convey the same meaning.
- Use short and direct sentences.
- Use the imperative form for required actions.
- Put one instruction in each sentence.
- Use the same term for the same concept.
- Define an acronym before you use it.
- Avoid ambiguous words and unnecessary detail.
- State the required behavior positively.
- Use a prohibition only for a necessary guardrail.

## Structure

- Use clear headings for related instructions.
- Use bullet points for rules and unordered actions.
- Use nested bullet points when items have a clear parent-child relationship. Keep unrelated items in a flat list.
- Avoid Markdown tables in terminal-facing instructions and skills.
- Use numbered lists when the order is important.
- Put conditions before the required action.
- Put commands and file paths in code formatting.
- Keep examples close to the instruction that they explain.
- Explicitly call a skill a "skill," such as "Run the `commit` skill."
- Do not repeat guidance that has one authoritative location.
- Keep instructions that apply to every task in the main document.
- Move conditional guidance to a referenced document or skill.
- Make each reference state when the reader must follow it.
- Do not copy commands, paths, or configuration that are easy to find in the repository.
- Document conventions, reasons, and hazards that the repository does not express.
- Focus architecture documentation on high-level architecture and system design.
- Include implementation and security details only when users need them to use, configure, operate, or secure the system.
- Keep a rule, its reason, and its exceptions in the same section.
- End each procedure with a result that the reader can verify.
- When a visual could clarify structure, flow, state, or change, read `<skill-dir>/references/visual-guidance.md` and use the smallest useful visual.

## Review

Before you finish an instruction change:

1. Remove duplicate and conflicting rules.
2. Split long sentences.
3. Replace dense paragraphs with lists when this improves parsing.
4. Check that each mandatory action has a clear condition.
5. Check that commands identify the correct working directory or file.
6. Confirm that each referenced path exists.
7. Confirm that each reference has a clear activation condition.
8. Remove details that duplicate repository configuration.
9. Remove stale instructions and instructions that do not change behavior.
