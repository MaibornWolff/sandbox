# Persistence

Project edits already remain on the host.
Use `persist_paths` to keep selected container data, such as agent history and dependency caches, after a container is removed.

```toml
persist_paths = [
  { path = "~/.claude" },
  { path = "~/.claude/.credentials.json", default = "{}", global = true },
  { path = "./node_modules", only_if_exists = true },
  { path = "./**/node_modules" },
]
```

A persistent project path hides the corresponding host project path in the container.
For example, container dependencies can use different native binaries from host dependencies without overwriting them.
New storage is empty, not copied from host dependencies.
Install dependencies inside Sandbox when needed.

## Options

- `path`: container path to keep.
  `~` means container home.
  `./` means project root.
  Ordinary bind persistence also accepts absolute paths under `/home/sandbox`.
  Use runtime-managed storage for absolute paths outside the container home.
- `global = true`: share stored data across projects.
  Default: separate data for each project.
- `default`: create a missing file with this string.
  Without it, a new path is an empty directory.
- `only_if_exists = true`: mount only if the corresponding host home or project path exists.
- `use_named_volume`: use runtime-managed storage with this name.

Paths must be normalized.
Sandbox rejects `.`, `..`, empty, or backslash segments and bare prefixes such as `~/`.
A trailing slash after a nonempty path is permitted.

Project-relative glob patterns select existing directories at container start.
They do not discover new directories during a session.

Normal persistent data is stored under `{data}/<project-slug>/` or `{data}/global/`.
Writes update that storage immediately.
See [configuration paths](CONFIGURATION.md#paths).

## Runtime-managed storage

Use this when tools need storage that is not a normal bind mount:

```toml
persist_paths = [{ path = "/nix", use_named_volume = "nix" }]
```

This storage is global across projects.
Docker and Podman use named volumes.
Apple uses runtime-owned host directories and initializes new storage from image contents.

Use an absolute or home-relative path.
Do not combine `use_named_volume` with `default`, `only_if_exists`, or a glob.
Use each volume name once.

## Remove data

`sandbox clean --data` removes current-project bind-persisted data and shared runtime storage targeted by cleanup.
It does not remove global bind-persisted data.
It can delete project logins and history, and shared cache or named-volume data used by other projects.
See [cleanup](UPDATES.md#cleanup) before running it.

Use [shared settings](SETTINGS-SYNC.md) instead when you want selected configuration shared between projects.
