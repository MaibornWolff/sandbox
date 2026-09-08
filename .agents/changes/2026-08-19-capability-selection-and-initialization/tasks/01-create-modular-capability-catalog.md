---
id: 01
dependencies: []
---

# Task 01: Create the modular capability catalog

Replace the central tool list with a typed, modular preset registry while preserving every supported capability. Add Python as a selectable runtime.

## Design

* `design.md#preset-and-registry-model`
* `design.md#keep-presets-modular`
* `design.md#use-typed-category-references`
* `design.md#derive-preset-membership`
* `design.md#derive-display-order`
* `design.md#preserve-the-catalog-by-capability`
* `design.md#keep-agent-catalogs-separate`

## Work

* [x] Add category, preset, and tool contracts under `src/modules/workspace-setup/tools/`, including branded category references and the fixed Languages, Tools, and AI agents sections
* [x] Create ecosystem and purpose preset modules under `src/modules/workspace-setup/tools/presets/`
* [x] Compose presets explicitly in `src/modules/workspace-setup/tools/presets/index.ts` and derive category membership from each tool declaration
* [x] Migrate every capability from `src/modules/workspace-setup/tools/tool-registry.ts` without losing installation, network, persistence, build-context, URL, alias, or agent-configuration data
* [x] Add the Python runtime and the broad JavaScript and Python user-default declarations required by the catalog
* [x] Preserve the link from installation capabilities to the existing agent configuration identifiers without merging the two catalogs
* [x] Validate duplicate category IDs, duplicate tool IDs, and tools assigned to a category outside their owning preset
* [x] Update catalog consumers and automated coverage to use registry order and declaration order without numeric ordering fields

## Verification

* [x] Every capability from the old registry remains available by the same identifier
  **Note:** Verified by `tool-registry.test.ts` and a field-by-field comparison of all 36 old declarations.
* [x] Python appears in the Languages section
  **Note:** Verified by `tool-registry.test.ts`.
* [x] Categories and tools appear in the specified stable order
  **Note:** Verified by `tool-registry.test.ts` and the application prompt tests.
* [x] A duplicate category, duplicate tool, or invalid preset member is rejected with a specific error
  **Note:** Verified by the `createToolRegistry` tests in `tool-registry.test.ts`.
* [x] Agent configuration lookup still works for each migrated AI agent
  **Note:** Verified against `AGENT_CONFIGS` in `tool-registry.test.ts`.
* [x] Relevant repository tests and checks pass
  **Note:** Verified with `bun check`.
