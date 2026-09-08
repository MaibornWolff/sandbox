---
id: 02
dependencies:
- 01
---

# Task 02: Model dependency selection and metadata

Represent direct and automatic capability selections as separate states. Resolve dependencies from direct tool references and persist only the user's direct choices.

## Design

* `design.md#dependency-behavior`
* `design.md#use-direct-dependency-references`
* `design.md#defaults-and-detection`

## Work

* [x] Replace string dependency identifiers with direct tool object references in the preset declarations
* [x] Update `src/modules/workspace-setup/tools/tool-resolution.ts` to return direct selections, automatic selections, dependency reasons, and the complete dependency closure
* [x] Preserve a capability as direct when the user selects an existing automatic dependency
* [x] Change clearing a direct dependency to automatic while another direct capability still requires it
* [x] Prevent removal of a required automatic dependency and expose the requiring capabilities for the user interface
* [x] Validate registry references to unregistered tools and reject dependency cycles with specific errors
* [x] Update Dockerfile metadata parsing and generation so each legacy `# Tools:` entry becomes direct and newly generated metadata excludes automatic dependencies
* [x] Add automated coverage for transitive dependencies, shared dependencies, promotion to direct, demotion to automatic, invalid references, cycles, and legacy metadata

## Verification

* [x] Selecting Agent Browser automatically includes each declared dependency with a visible reason
  **Note:** Verified by dependency resolution tests and the Dockerfile generation test for Agent Browser, Node.js, and Chromium.
* [x] Selecting an automatic dependency directly keeps it after the dependent capability is cleared
  **Note:** Verified by the promotion and dependent-clearing test in `tool-resolution.test.ts`.
* [x] Clearing its direct state keeps it automatic while another selected capability requires it
  **Note:** Verified by the demotion test in `tool-resolution.test.ts`.
* [x] A required automatic dependency cannot be removed
  **Note:** Verified by the removal rejection test in `tool-resolution.test.ts`, including both requiring capability names.
* [x] Generated selection metadata contains direct selections only
  **Note:** Verified by the direct-selection metadata tests in `dockerfile-generation.test.ts`, including an empty direct selection.
* [x] Existing valid `# Tools:` metadata restores every listed tool as a direct selection
  **Note:** Verified by the legacy metadata test in `build-context-detection.test.ts`.
* [x] Relevant repository tests and checks pass
  **Note:** Verified with focused tests and `bun check`.
