---
id: 04
dependencies:
- 01
---

# Task 04: Generate phased image setup

Generate image layers from typed setup actions instead of exposing installation methods in capability selection. Run all root actions before one ownership barrier and all container-user actions after it.

## Design

* `design.md#image-generation-boundary`
* `design.md#separate-presentation-from-installation`
* `design.md#model-image-setup-by-execution-identity`
* `design.md#use-plural-image-setup-actions`

## Work

* [x] Add typed image setup actions and plural helpers in `src/modules/workspace-setup/tools/image-setup.ts` for apt, npm, Mise, Go, and Cargo packages
* [x] Pass package-manager-native package and version strings through without parsing them into separate fields
* [x] Migrate preset installation declarations to `imageSetup.asRoot` and `imageSetup.asContainerUser`
* [x] Require root actions to declare each absolute container path that the container user must own
* [x] Update `src/modules/workspace-setup/tools/dockerfile-generation.ts` to bundle package actions by package manager and preserve declaration order for other actions
* [x] Combine all root actions, apply ownership once, and then combine all container-user actions
* [x] Prevent generated setup actions from switching back to root after the container-user phase starts
* [x] Keep image-build ownership separate from runtime mount ownership
* [x] Preserve direct selection metadata, explanatory tool and token comments, and existing generated configuration behavior
* [x] Add behavioral generation coverage for mixed actions, package versions, ownership, ordering, comments, and invalid owned paths

## Verification

* [x] Mixed capabilities produce one root phase followed by one container-user phase
  **Note:** Verified by `phased Dockerfile generation > runs all root actions before one ownership barrier and all user actions after it`.
* [x] Ownership changes occur once between the two phases
  **Note:** Verified by the mixed-phase and complete-catalog cases in `dockerfile-generation.test.ts`.
* [x] No root setup action or user switch appears during the container-user setup phase
  **Note:** Verified by checking the generated setup phase in both mixed and complete-catalog generation tests. After setup, the generator restores the root runtime user because the managed entrypoint configures networking and mount ownership before it drops privileges.
* [x] Package actions are bundled by package manager and other actions retain declaration order within their phase
  **Note:** Verified by the package bundling and action ordering tests in `dockerfile-generation.test.ts`.
* [x] Native version strings reach the applicable package manager unchanged
  **Note:** Verified for apt, npm, Mise, Go, and Cargo by `phased Dockerfile generation > passes native package and version strings through unchanged`.
* [x] Relative ownership paths are rejected with a specific error
  **Note:** Verified by `phased Dockerfile generation > rejects a relative image-build ownership path with a specific error`.
* [x] Generated images retain the behavior of all migrated capabilities
  **Note:** Verified by the complete-catalog and explanatory-comment cases in `dockerfile-generation.test.ts` and the full repository test suite.
* [x] Relevant repository tests and checks pass
  **Note:** Verified with `bun check`.
