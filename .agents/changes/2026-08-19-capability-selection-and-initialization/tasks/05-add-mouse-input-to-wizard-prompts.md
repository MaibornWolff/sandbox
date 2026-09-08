---
id: 05
dependencies: []
---

# Task 05: Add mouse input to wizard prompts

Add shared mouse interaction to the complete initialization wizard without removing any keyboard action. Keep terminal cleanup and native link behavior safe.

## Design

* `design.md#input-model`
* `design.md#mouse`
* `design.md#support-keyboard-and-mouse-input`

## Work

* [x] Extend the shared terminal prompt primitives under `src/platform/terminal/` with scoped mouse tracking, parsed click events, and wheel release to native terminal scrolling
* [x] Enable mouse tracking only while an interactive prompt is active and always restore terminal state on submit, cancellation, abort, and failure
* [x] Add row and control hit regions for selection, expansion, actions, and scrolling
* [x] Apply mouse behavior to checkbox, single-select, confirmation, file-review, agent-configuration, and capability prompts used by the wizard, with checkbox hit regions based on wrapped physical rows
* [x] Preserve all existing keyboard and Vim-style controls
* [x] Keep visible URLs usable and preserve terminal-native modifier-click behavior where the terminal permits it
* [x] Extend the application TUI test harness with generic click and wheel interaction primitives
* [x] Add automated coverage for mouse activation, wheel scrolling, keyboard parity, cancellation, and terminal cleanup

**Boundary:** File review and agent configuration use the shared single-select, checkbox, and confirmation prompts. Task 06 owns the capability tree prompt. The shared mouse parser, scoped tracking, and hit-region APIs are ready for that prompt.

## Verification

* [x] A user can complete every wizard prompt with the mouse
  **Note:** Verified the checkbox, single-select, confirmation, and capability prompt forms. Checkbox coverage includes wrapped labels, and `init.test.ts` covers project capability selection.
* [x] Clicking a row or its selection symbol performs the documented action
  **Note:** Verified checkbox and single-select row activation in `select.test.ts`. Wrapped physical lines remain part of the correct checkbox hit target.
* [x] Clicking a group label expands or collapses it
  **Note:** Verified by the capability section click test in `capability-editor.test.ts`.
* [x] The mouse wheel scrolls terminal history without changing the focused option
  **Note:** Verified that the first wheel event releases mouse tracking and keeps the current selection in `select.test.ts`.
* [x] Every mouse action remains available from the keyboard
  **Note:** Verified arrow, Vim-style, Space, Enter, and confirmation keyboard paths in `select.test.ts` and `prompt.test.ts`.
* [x] Mouse tracking is disabled after completion, cancellation, abort, or failure
  **Note:** Verified submit, Control-C, abort, and thrown-error cleanup in `mouse.test.ts`, `select.test.ts`, and `prompt.test.ts`.
* [x] Visible URLs remain readable when mouse tracking is active
  **Note:** Verified a visible documentation URL and an unused modifier-click in `select.test.ts`.
* [x] Relevant repository tests and checks pass
  **Note:** Verified with `bun check`.
