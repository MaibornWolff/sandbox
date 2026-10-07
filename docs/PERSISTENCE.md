# Persistence

Container data is temporary unless it is in a mounted path. Configure a persistent path to keep selected data after the container stops.

## Storage Scopes

### Per-project storage

Per-project storage is the default. Each project has separate data.

```
{data}/
├── myapp-abc123/
│   └── .claude/
└── other-project-def456/
    └── .claude/
```

Use this scope for project-specific state such as conversation history.

### Global storage

Global storage is shared between projects.

```
{data}/
└── global/
    └── .claude/
        └── .credentials.json
```

Use this scope only for data that must be available in multiple projects.

`{data}` is the Sandbox data directory. Its location depends on the host platform and the X Desktop Group (XDG) Base Directory environment variables.

## Options

| Option | Result |
| --- | --- |
| `path` | Select the container path to keep |
| `global` | Share the data between projects |
| `default` | Create a file with this content when the path does not exist |
| `only_if_exists` | Create the mount only when the corresponding host path exists |
| `use_named_volume` | Store the path in a runtime-managed named volume |

When `default` is absent, Sandbox creates an empty directory for a new persistent path.

### Use `only_if_exists`

Set `only_if_exists = true` to avoid new empty directories for optional paths.

For a `~/` path, Sandbox checks the host home directory. For a `./` path, Sandbox checks the project directory.

### Use file patterns

A file pattern can select matching project directories. File patterns only work with project-relative paths.

```toml
persist_paths = [
  { path = "./**/node_modules" },
]
```

Sandbox selects directories that exist when the container starts.

## Host Storage

Sandbox bind-mounts host storage at each persistent container path.

```
Container path                    Host storage
~/.claude                  <-     {data}/{project}/.claude
~/.claude/.credentials     <-     {data}/global/.claude/.credentials
```

Writes to these container paths update the host storage immediately.

## Runtime-managed storage

Use runtime-managed storage when a tool cannot use a bind mount. This storage is shared between all projects. Docker and Podman map it to a named volume. Apple maps it to an adapter-owned host directory. Sandbox uses an opaque storage handle and does not depend on the native resource name. The runtime refuses removal while an instance uses the storage.

```toml
persist_paths = [
  { path = "/nix", use_named_volume = "nix" },
]
```

Sandbox adds the `sandbox-` prefix to the configured value. The example creates the logical storage key `sandbox-nix`. The selected runtime maps this key to its own storage system.

When Apple storage is first allocated, the adapter copies image directory contents into it before the instance starts. It stages the copy and serializes concurrent initialization. It does not replace existing storage, including empty storage from earlier versions. Copied children retain their metadata. The mount root retains host-directory metadata. Later starts do not repeat the copy.

Cleanup uses recorded storage handles. If a global storage handle is not recorded, the runtime looks up the current resource without creating it.

Apply these rules:

- Use an absolute path or a home-relative path.
- Do not combine `use_named_volume` with `default`.
- Do not combine `use_named_volume` with `only_if_exists`.
- Do not use a file pattern with `use_named_volume`.
- Use each named-volume value only once.

## Remove Stored Data

Run `sandbox clean --data` to remove persistent Sandbox data.

## See Also

- [Architecture](./ARCHITECTURE.md)
- [Mounts](./MOUNTS.md)
- [Settings Synchronization](./SETTINGS-SYNC.md)
- [Configuration Cascade](./CONFIG-CASCADE.md)
