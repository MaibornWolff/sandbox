# Settings Synchronization

Sandbox sends selected host settings to each container. All projects use one host settings directory.

`{config}` is the Sandbox configuration directory. Its location depends on the host platform.

## Modes

A string uses `mount` mode. A table can select `mount` or `copy` mode.

```toml
settings = [
  "~/.claude/settings.json",
  { path = "~/.codex/config.toml", mode = "copy" },
  { path = "~/.some-tool/config/", mode = "copy" },
]
```

### Mount mode

Sandbox creates a read-write bind mount for each selected host path.

```text
Host:      {config}/settings/.claude/settings.json
Container: /home/sandbox/.claude/settings.json
```

Changes to an existing mounted path are immediate on both sides.

A container can create a new path that matches a mount pattern. Sandbox copies the new path to the host when the last session ends and the container stops normally.

A forced runtime or host stop can prevent this copy operation.

### Copy mode

Sandbox copies the selected source into the container home at each container start.

At startup, Sandbox does these steps:

1. Skip the entry if the host source does not exist.
2. Remove the old container destination.
3. Create the destination parent.
4. Copy the full file or directory.

A skipped entry can use a container-local destination. Sandbox applies the copy on a later start if the host source appears.

The container can replace the copied path with an atomic rename. Container changes do not change the host source. Sandbox restores the host version at the next container start.

Sandbox follows relative symbolic links when their targets stay in the settings directory. Copy setup rejects absolute links and links that leave the settings directory.

Copy entries must use literal paths. Do not use globs or exclusion patterns in copy entries.

## File Patterns

Mount entries can use glob and exclusion patterns.

```toml
settings = [
  "~/.claude/**",
  "!~/.claude/projects",
]
```

Sandbox uses the same selection rules for container setup, configuration display, diagnostics, and shutdown synchronization.

## Persistent Paths

A persistent parent can contain a copied setting.

```toml
settings = [{ path = "~/.codex/config.toml", mode = "copy" }]
persist_paths = [{ path = "~/.codex" }]
```

Sandbox replaces the copied child at every container start.

A copied destination cannot also be a direct mount point. For example, do not persist or mount `~/.codex/config.toml` directly.

## Limitations

- All projects use the same host settings directory.
- A project can select different settings, but it cannot define a different source directory.
- A forced stop can lose new mount-mode paths that were not bind-mounted at startup.
- Copy-mode changes inside the container are temporary.

## See Also

- [Architecture](./ARCHITECTURE.md)
- [Persistence](./PERSISTENCE.md)
- [Configuration Cascade](./CONFIG-CASCADE.md)
