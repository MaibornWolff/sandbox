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

#### Symbolic links

Every container can write the settings directory. A container can replace a setting with a symbolic link. If Sandbox followed such a link, a container could mount any host path read-write at the next container start.

Sandbox resolves each selected mount path before the container starts. It stops the start if the resolved path is outside the settings directory. The error lists each affected settings entry, its link, and `mounts` entries that replace it.

Sandbox accepts these links:

- The settings directory itself can be a link.
- A link can point to another path inside the settings directory, for example `.claude -> shared/claude`.
- A mounted directory can contain links, for example `.claude/foo -> /opt/foo`. The container resolves these links in its own filesystem.

Glob patterns do not traverse linked directories. For example, `**/settings.json` does not select files below a linked `.claude` directory.

#### Replace external links with mounts

If a setting is a link to a path outside the settings directory, replace the link with a `mounts` entry in the global `{config}/config.toml`. Containers cannot write this file.

Example: `{config}/settings/.example-tool` links to `~/dotfiles/example-tool`.

1. Remove `~/.example-tool` from `settings`, or delete the link `{config}/settings/.example-tool`. Either step stops the error.
2. Add the mount to the `mounts` list:

   ```toml
   mounts = ["~/dotfiles/example-tool:~/.example-tool:rw"]
   ```

For a glob entry, the error suggests a mount for the path before the first glob. For example, `~/.example-tool/agent/*` becomes a mount of `~/.example-tool/agent`.

A mount has these differences from a setting:

- It has no glob patterns and no copy of new paths to the host.
- It applies to all projects.
- It must not use the same container path as an entry in `persist_paths` or another mount.

Use `:ro` if the tool only reads the files.

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
- The link check and the runtime mount do not run as one operation. A compromised container that runs at the same time can replace a checked path with a link before the runtime mounts it. Most attempts fail with the link error, so check the settings directory if this error appears without a reason.

## See Also

- [Architecture](./ARCHITECTURE.md)
- [Persistence](./PERSISTENCE.md)
- [Configuration Cascade](./CONFIG-CASCADE.md)
