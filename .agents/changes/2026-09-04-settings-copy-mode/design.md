---
datetime: 2026-09-04T13:49:31+00:00
author: Tobias Wagner
tags: [settings, containers, configuration]
---

# Settings Copy Mode

## Context

Sandbox currently bind-mounts each selected setting from the host settings directory into the container home. This gives both sides immediate access to the same file.

Some tools replace configuration files through an atomic rename. An atomic rename cannot replace an individual bind-mount target. For example, Codex can fail to update `~/.codex/config.toml` with `EBUSY` or `EXDEV`.

The branch `origin/feat/better-mounting-and-ps` has a copy strategy for this problem. That design copies a setting once into a configured persistent parent. This design uses different behavior:

- Persistence is optional.
- The host setting is the source of truth.
- Sandbox replaces the destination on every container start.
- Copy mode supports files and directories.

Related documents:

- [`docs/SETTINGS-SYNC.md`](../../../docs/SETTINGS-SYNC.md)
- [`docs/PERSISTENCE.md`](../../../docs/PERSISTENCE.md)
- [`docs/CONFIG-CASCADE.md`](../../../docs/CONFIG-CASCADE.md)

## Intended Configuration

A string keeps the current mount behavior. A table can select a mode explicitly.

```toml
settings = [
  "~/.claude/settings.json",
  { path = "~/.codex/config.toml", mode = "copy" },
  { path = "~/.some-tool/config/", mode = "copy" },
]
```

The equivalent normalized forms are:

```text
"~/.claude/settings.json"
  -> { path: ".claude/settings.json", mode: "mount" }

{ path: "~/.codex/config.toml", mode: "copy" }
  -> { path: ".codex/config.toml", mode: "copy" }
```

## Behavior

This diagram separates host paths from container paths.

```text
HOST                                              SANDBOX CONTAINER

{config}/settings/
|-- .claude/settings.json -- bind mount --------> ~/.claude/settings.json
|
|-- .codex/config.toml ------ fresh copy --------> ~/.codex/config.toml
|
`-- .some-tool/config/ ------ fresh copy --------> ~/.some-tool/config/
                                                       |
                                                       `-- freely writable
```

At each container entrypoint start, before the container becomes ready:

```text
for each mode="copy" entry
  find the source in /etc/sandbox/settings
  skip the entry if the source does not exist
  remove the existing destination file or directory
  create the destination parent
  copy the complete source to the destination
```

The copy operation runs as the `sandbox` user. The new paths therefore have the correct owner.

The shutdown flow is:

```text
mode="mount"  -> sync new matching paths that had no startup mount
mode="copy"   -> do not sync changes to host settings
```

Existing mounted paths update host settings immediately. They do not need shutdown synchronization.

An already-running container does not reapply copied settings when another session connects. Application occurs when the container entrypoint starts.

## Key Decisions

### Use `mode` in settings entries

- **Decision:** Use `mode = "mount" | "copy"`. Default plain strings and tables without a mode to `mount`.
- **Reason:** `mode` is short and describes the selected behavior in configuration.
- **Trade-offs:** The word can also describe `ro` and `rw` mount access. Settings entries do not expose those values, so the local meaning stays clear.

### Replace copied settings on every container start

- **Decision:** Remove the old destination and copy the full source before the container becomes ready.
- **Reason:** The host setting must remain the source of truth. Each start must have a known configuration.
- **Trade-offs:** Changes made only inside the sandbox are lost at the next start. Replacing a large directory can increase startup time.

### Support files and directories

- **Decision:** Apply the same replacement behavior to literal files and literal directories.
- **Reason:** A user who selects copy mode expects the selected host setting to replace the sandbox setting. This behavior is safe for user-selected settings directories.
- **Trade-offs:** A copied directory cannot keep generated children that are absent from the host source.

### Keep persistence optional

- **Decision:** Copy into the container home without requiring a covering `persist_paths` entry.
- **Reason:** Startup configuration delivery and persistence are separate concerns.
- **Trade-offs:** If a persistent parent exists, Sandbox still replaces the copied child on every start. Persistence does not preserve sandbox-only changes below that child.

### Exclude copies from settings mounts and shutdown sync

- **Decision:** Do not create a destination bind mount for copy entries. Do not include copy entries in shutdown synchronization.
- **Reason:** A destination bind mount would keep the atomic-rename failure. Shutdown synchronization would let one project change the shared source for other projects.
- **Trade-offs:** Users must update the host settings source when they want a lasting change.

### Sync new mount-mode settings on container stop

- **Decision:** Use `syncNewSettingsOnContainerStop()` to copy only new matching mount-mode paths that had no host source at container start.
- **Reason:** Existing mounted paths already update the host immediately. The stop operation is necessary only for a new path that could not be mounted because it did not exist at startup.
- **Trade-offs:** A forced stop can lose new paths. Removing this operation would make newly created matching settings temporary.

### Require literal source paths

- **Decision:** Accept literal files and directories for copy mode. Reject globs and exclusion patterns.
- **Reason:** One copy entry must identify one source and one destination. This gives replacement a clear meaning.
- **Trade-offs:** Users need separate entries for separate sources. Glob support can be designed later if a real use case needs it.

### Skip missing copy sources

- **Decision:** Skip a copy entry when its host source does not exist. Treat a failed replacement of an existing source as a startup error.
- **Reason:** This matches mount mode and lets default settings include optional tools. A later container start applies the copy if the host source appears.
- **Trade-offs:** A container-local destination remains unchanged while the host source is absent.

### Expose one deep sandbox settings abstraction

- **Decision:** Expose settings behavior through `SandboxSettings`. Keep mode separation, manifests, path selection, mounts, copying, and migration private.
- **Reason:** Callers must express lifecycle intent without coordinating technical settings steps.
- **Trade-offs:** The abstraction has methods that run in different processes. Their lifecycle-specific names make this boundary explicit.

### Keep strict configuration validation

- **Decision:** Reject unknown settings entry fields through the existing strict schema.
- **Reason:** A misspelled `mode` must not silently fall back to a bind mount.
- **Trade-offs:** Invalid configuration blocks startup instead of producing a warning.

## Main Abstractions

### Configuration types

```ts
type SettingsMode = "mount" | "copy";

type SettingsEntryInput =
  | string
  | {
      path: string;
      mode?: SettingsMode;
    };

type SettingsEntry = {
  path: string;
  mode: SettingsMode;
};
```

`SettingsEntryInput` represents TOML input. `SettingsEntry` is the normalized runtime form. Its path has no `~/` prefix.

### Sandbox settings entry point

`sandbox-settings` exposes one lifecycle-oriented abstraction:

```ts
type SandboxSettings = {
  getHostDirectory(): string;
  createContainerSetup(
    options: CreateSettingsContainerSetupOptions,
  ): Promise<PreparedSettings>;
  applyOnContainerStart(): Promise<void>;
  syncNewSettingsOnContainerStop(): Promise<readonly string[]>;
  inspectHost(
    entries: readonly SettingsEntry[],
  ): Promise<SettingsInspection>;
};

function getSandboxSettings(): SandboxSettings;
```

The methods hide path selection, mode separation, mounts, manifest transport, filesystem replacement, and stale migration.

```text
HOST
  createContainerSetup
    -> mounts and internal environment

SANDBOX CONTAINER START
  applyOnContainerStart
    -> fresh copy-mode files and directories

SANDBOX CONTAINER STOP
  syncNewSettingsOnContainerStop
    -> new mount-mode paths with no host source at startup

HOST DISPLAY AND DIAGNOSTICS
  inspectHost
    -> one shared inspection model
```

Existing mounted paths do not need stop-time synchronization. Their read-write bind mounts update the host immediately.

### Private container settings manifest

The host passes an internal manifest to the container tools through `SANDBOX_SETTINGS`:

```json
{
  "mountPaths": [".claude/settings.json"],
  "copyPaths": [".codex/config.toml", ".some-tool/config/"]
}
```

The manifest replaces the current string-array value. Only `sandbox-settings` creates, parses, or uses it. Other components do not coordinate `mountPaths` and `copyPaths`.

## Architecture Integration

The component has one public entry point. Internal files own complete lifecycle operations or hide a technical mechanism.

```text
src/modules/sandbox-settings/
|-- index.ts
|   `-- export SandboxSettings and getSandboxSettings
|
|-- sandbox-settings.ts
|   `-- public lifecycle abstraction and clear reading entry point
|
|-- container-settings-setup.ts
|   `-- source mount, destination mounts, conflicts, migration, manifest
|
|-- container-start-settings.ts
|   `-- replace copy-mode files and directories
|
|-- container-stop-settings-sync.ts
|   `-- copy new mount-mode paths to host settings
|
|-- host-settings-inspection.ts
|   `-- shared display and diagnostic model
|
|-- settings-manifest.ts
|   `-- private creation, serialization, and strict parsing
|
|-- settings-selection.ts
|   `-- glob expansion, exclusions, deduplication, and symlinks
|
|-- settings-mounts.ts
|   `-- convert selected host paths into container mounts
|
|-- settings-conflicts.ts
|   `-- reject copied destinations that are direct mount points
|
|-- settings-paths.ts
|   `-- own host and container settings roots
|
`-- stale-symlink-migration.ts
    `-- isolate compatibility behavior
```

The public facade exports only the deep abstraction and its result types. It does not export manifest parsing, path selection, mount resolution, copy functions, or stale symlink cleanup.

### Host container setup

```text
buildStructuralArgs
  getPersistentMounts
  getSandboxSettings().createContainerSetup
    create private manifest
    mount host settings at /etc/sandbox/settings
    mount only mode="mount" destinations
    validate copy destination conflicts
    remove stale settings symlinks
    return mounts and environment variables
  add prepared settings to container arguments
```

The container argument builder does not serialize settings or separate modes.

### Container start

```text
runContainerEntrypoint
  prepareContainerState
  repairMountOwnership
  run settings apply command as sandbox user
    getSandboxSettings().applyOnContainerStart
      read private manifest
      skip copy paths with no host source
      replace existing copy-mode destinations
  initializeManagedNetwork
  markContainerReady
```

The settings apply operation must finish before readiness. Its failure stops startup.

### Container stop

```text
runContainerEntrypoint shutdown
  terminate active sessions
  run settings sync command as sandbox user
    getSandboxSettings().syncNewSettingsOnContainerStop
      read private manifest
      select mount-mode paths
      copy only paths absent from host settings
```

A synchronization failure is logged and does not replace the container exit status.

### Host inspection

```text
config display or diagnostics
  getSandboxSettings().inspectHost
    use the same selection rules as container setup
    report mounted, copied, and missing paths
```

This removes duplicate settings matching from configuration display and diagnostics.

## Conflict Handling

A copied destination must not also be a direct mount point. This includes a direct custom mount or a persistence entry for the exact destination. A mounted parent is valid.

```text
Valid:
  persist ~/.codex
  copy    ~/.codex/config.toml

Invalid:
  persist ~/.codex/config.toml
  copy    ~/.codex/config.toml
```

The generated settings mounts avoid this conflict by using only `mountPaths`. Other direct-mount conflicts must fail with a path-specific error before readiness.

## Test Scope

Add tests at the lowest responsible level:

- Configuration tests for strings, table entries, defaults, strict fields, globs, and exclusions.
- `SandboxSettings.createContainerSetup()` tests for mode separation, mounts, the private manifest, and conflicts.
- `SandboxSettings.applyOnContainerStart()` tests with real temporary files and directories.
- Container-start tests for replacement, skipped missing sources, ownership-safe execution boundaries, and copy failures.
- Container argument tests that treat prepared settings as one result.
- Entrypoint tests for apply order, fatal startup failures, and readiness.
- `SandboxSettings.syncNewSettingsOnContainerStop()` tests that copy new mount-mode paths and exclude copy-mode paths.
- Inspection tests that use the same path selection rules as container setup.
- End-to-end tests for existing and missing mount-mode and copy-mode files, including atomic file replacement.

## Non-goals

- Do not copy sandbox changes back to host settings for copy mode.
- Do not preserve sandbox-only children below a copied directory.
- Do not add copy globs or copy exclusions.
- Do not require or create persistence entries.
- Do not cherry-pick the old branch implementation. Port the behavior into the current component architecture.

## Open Questions

### Symbolic links in copied directories

The current settings synchronization follows symbolic links when it copies new settings to the host. The copy refresh needs an explicit rule for symbolic links in a host source directory.

Candidate rule: Follow links and copy their content. This prevents the sandbox destination from depending on a host path that is not mounted into the container.
