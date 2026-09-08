---
id: 06
dependencies:
- 01
- 02
- 05
---

# Task 06: Build the capability tree editor

Replace category-by-category tool prompts with one searchable capability tree and a review action. Show direct, automatic, partial, expanded, collapsed, and focused states without duplicating capabilities.

## Design

* `design.md#capability-tree`
* `design.md#visual-states`
* `design.md#description-panel`
* `design.md#search`
* `design.md#keyboard`
* `design.md#show-dependencies-as-automatic-selections`
* `design.md#use-one-expandable-capability-editor`

## Work

* [x] Replace the current `selectTools` category flow with a capability editor backed by the preset registry and dependency selection state
* [x] Render fixed Languages, Tools, and AI agents sections with canonical category and tool locations, clearly indented tool leaves, terminal-height-aware paging, counts, and the specified visual states and restrained colors
* [x] Add keyboard navigation for arrows, Vim keys, Space, Enter, Tab, Shift+Tab, Home, End, `g`, `G`, and `/`
* [x] Add expansion and selection behavior for sections, categories, leaves, and `[ Continue ]` actions at both ends of the tree
* [x] Show the focused capability in a fixed description panel with its name, description, and visible documentation URL
* [x] Emit an Operating System Command 8 hyperlink when the terminal supports it
* [x] Search names, descriptions, URLs, aliases, parent groups, and ecosystems across collapsed descendants
* [x] Keep matching ancestors visible and restore the earlier expansion state after search closes
* [x] Show automatic dependency reasons and prevent invalid dependency removal through the editor
* [x] Add a review view that distinguishes direct and automatic selections before continuation
* [x] Add low-level prompt coverage and application-level keyboard and mouse interaction coverage

## Verification

* [x] The complete catalog is editable in one tree
  **Note:** Verified by `capability-editor.test.ts` and the interactive `sandbox init` tests. The visible tree uses the available terminal height, up to 30 rows.
* [x] Each capability appears at one canonical location
  **Note:** Verified by the registry-backed tree construction and `tool-registry.test.ts` catalog order checks.
* [x] Direct, automatic, partial, focused, expanded, and collapsed states render distinctly
  **Note:** Verified by the dependency review, promotion and demotion, collapse, focus, and mouse tests in `capability-editor.test.ts`.
* [x] Search finds collapsed descendants through every specified searchable field
  **Note:** Verified by the alias, name, description, URL, parent group, and ecosystem search tests in `capability-editor.test.ts`.
* [x] Closing search restores the previous expansion state
  **Note:** Verified by the collapsed Languages search test in `capability-editor.test.ts`.
* [x] The fixed panel follows focus and keeps the documentation URL visible
  **Note:** Verified by the Node.js focus and Operating System Command 8 hyperlink test in `capability-editor.test.ts`.
* [x] Keyboard and mouse users can reach review and produce the same selection result
  **Note:** Verified by the low-level keyboard tests and the mouse-only project initialization test in `init.test.ts`. Both select `node`.
* [x] Relevant repository tests and checks pass
  **Note:** Verified with `bun check`.
