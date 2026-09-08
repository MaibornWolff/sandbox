---
id: 07
dependencies:
- 03
- 04
- 06
---

# Task 07: Integrate the user initialization flow

Make `sandbox init` select agents first and then configure the complete capability catalog. Restore prior direct selections when possible and use defaults plus host detection only for a new setup.

## Design

* `design.md#user-setup`
* `design.md#defaults-and-detection`
* `design.md#keep-agents-prominent`
* `design.md#use-broad-user-defaults-and-granular-project-detection`

## Work

* [x] Update `src/modules/workspace-setup/initialization/user-initialization.ts` to show a dedicated AI agent screen before the complete capability editor
* [x] Repeat AI agents in the capability tree so the user can revise the initial choice
* [x] Restore direct selections from generated Dockerfile metadata for an existing setup
* [x] For a new setup, combine built-in broad JavaScript and Python defaults with matching user detector declarations
* [x] Give recovered generated selections precedence over new-setup defaults and host detection
* [x] Pass final direct selections through dependency resolution and phased image generation
* [x] Keep agent settings configuration after capability review and link it through the existing agent configuration identifier
* [x] Review generated files through the existing file update flow and preserve cancellation and error exit behavior
* [x] Update application integration coverage for new setup, restored setup, detected capabilities, automatic dependencies, agent revision, and generated files

## Verification

* [x] A new user sees the AI agent screen first
  **Note:** Verified by `sandbox init > creates user files and remains isolated from process workspace values` in `src/apps/sandbox/init.test.ts`.
* [x] Broad JavaScript and Python capabilities are selected by default for a new setup
  **Note:** Verified by the generated direct-selection metadata and Python image action assertions in `sandbox init > creates user files and remains isolated from process workspace values`.
* [x] Matching host declarations add capabilities without removing defaults
  **Note:** Verified by `sandbox init > adds detected user capabilities without removing broad defaults` with a host Java executable fixture.
* [x] Existing generated direct selections are restored instead of applying new-user defaults
  **Note:** Verified by the generated-selection restoration tests in `src/apps/sandbox/init.test.ts`. They cover a Copilot selection and an empty selection.
* [x] The user can revise AI agent choices in the complete tree
  **Note:** Verified by `sandbox init > lets the user revise the initial agent selection in the complete tree`.
* [x] Agent settings are configured only after capability review
  **Note:** Verified by prompt output ordering in `sandbox init > copies detected agent settings and enables the selected bypass`.
* [x] Generated metadata contains direct selections while the image includes their dependency closure
  **Note:** Verified by the Copilot-only metadata and Node.js plus Copilot installation assertions in `sandbox init > restores generated direct selections and includes automatic dependencies`.
* [x] Relevant repository tests and checks pass
  **Note:** Verified by `bun test src/apps/sandbox/init.test.ts` and `bun check`.
