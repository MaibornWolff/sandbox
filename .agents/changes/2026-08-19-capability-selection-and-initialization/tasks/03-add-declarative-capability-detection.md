---
id: 03
dependencies:
- 01
---

# Task 03: Add declarative capability detection

Detect user and project capabilities from declarations owned by each tool. Keep capability detection separate from image build-context copying.

## Design

* `design.md#defaults-and-detection`
* `design.md#detection-declarations`
* `design.md#keep-detection-with-each-tool`
* `design.md#restrict-detection-paths`

## Work

* [x] Add `hasExecutable()` and `hasPath()` detector declarations in `src/modules/workspace-setup/tools/detection.ts`
* [x] Add explicit `duringUserInit` and `duringProjectInit` detector lists to applicable preset tool declarations
* [x] Evaluate each detector list with OR semantics and return direct capability selections
* [x] Resolve user paths with support for `~/` and absolute paths while rejecting relative paths
* [x] Resolve `./` project paths from the resolved repository root with platform path APIs
* [x] Normalize project paths and reject absolute paths or traversal outside the project root
* [x] Ensure project detection does not execute or inspect host commands
* [x] Separate detection declarations from `src/modules/workspace-setup/initialization/build-context-detection.ts` so detection does not imply that a file is copied
* [x] Add automated coverage with real temporary filesystems and explicit Windows and POSIX path fixtures

## Verification

* [x] A matching user executable or user path selects its declared capability
  **Note:** Verified by `detection.test.ts` with an executable fixture and a real user marker file.
* [x] A matching project configuration or lock file selects only its declared project capability
  **Note:** Verified by `detection.test.ts` with real `package.json` and `pnpm-lock.yaml` files.
* [x] Multiple declarations for one initialization scope use OR semantics
  **Note:** Verified by the user and project OR cases in `detection.test.ts`.
* [x] Invalid user-relative, project-absolute, and escaping project paths are rejected
  **Note:** Verified by `detection.test.ts` with POSIX and Windows path fixtures.
* [x] Project detection never runs host executable checks
  **Note:** Verified by the malformed project detector boundary test in `detection.test.ts`.
* [x] A detected file is not copied unless a separate build-context declaration requests it
  **Note:** Verified by `detection.test.ts`, `tool-registry.test.ts`, and the build-context behavior tests. PHP detection has no build-context declaration. Mise detection has separate copy declarations.
* [x] Relevant repository tests and checks pass
  **Note:** Verified with focused detection, registry, and initialization tests, followed by `bun check`.
