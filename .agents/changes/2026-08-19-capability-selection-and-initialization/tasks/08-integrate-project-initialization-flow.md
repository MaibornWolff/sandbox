---
id: 08
dependencies:
- 03
- 04
- 06
---

# Task 08: Integrate the project initialization flow

Make `sandbox init --project` create configuration without requiring a project image. Detect minimal project capabilities only when the user chooses image customization.

## Design

* `design.md#project-setup`
* `design.md#defaults-and-detection`
* `design.md#keep-project-dockerfiles-optional`
* `design.md#use-broad-user-defaults-and-granular-project-detection`

## Work

* [x] Update `src/modules/workspace-setup/initialization/project-initialization.ts` to ask whether the project image needs customization
* [x] Create only `.sandbox/config.toml` when the user declines image customization
* [x] Preserve an existing `.sandbox/docker/Dockerfile` unchanged when customization is declined
* [x] Run project detector declarations from the resolved project root when customization is accepted
* [x] Preselect only capabilities supported by project evidence and do not preselect AI agents
* [x] Open the complete capability editor with project detections as direct selections
* [x] Generate or review the project Dockerfile only for the customization path
* [x] Keep build-context copying explicit and limited to selected capabilities with separate copy declarations
* [x] Preserve and validate the non-interactive `--tools` project flow without introducing host-command detection
* [x] Update application integration coverage for config-only setup, preserved Dockerfiles, detected lock files, no agent defaults, customized images, and generated-file review

## Verification

* [x] Declining customization creates project configuration without creating a Dockerfile
  **Note:** Verified by `creates only project config when image customization is declined` in `src/apps/sandbox/init.test.ts`.
* [x] Declining customization does not modify an existing project Dockerfile
  **Note:** Verified by `preserves an existing project Dockerfile when customization is declined` in `src/apps/sandbox/init.test.ts`.
* [x] Accepting customization preselects only capabilities supported by project files
  **Note:** Verified with project-root `package.json`, `pnpm-lock.yaml`, and `.mise.toml` cases in `src/apps/sandbox/init.test.ts`.
* [x] Project initialization does not inspect host executables or preselect AI agents
  **Note:** Verified by the project tests that add a host `claude` executable and assert that the generated Dockerfile does not contain Claude Code.
* [x] Selected build-context files are copied only through explicit copy declarations
  **Note:** Verified by the non-interactive test that leaves an unselected `.mise.toml` uncopied and the selected Mise test that copies it.
* [x] The non-interactive project flow remains deterministic and rejects unknown capability IDs
  **Note:** Verified by the explicit `node,pnpm` test, the rerun test, and the unknown-capability test in `src/apps/sandbox/init.test.ts`.
* [x] Relevant repository tests and checks pass
  **Note:** Verified with `bun test src/apps/sandbox/init.test.ts` and `bun check`.
