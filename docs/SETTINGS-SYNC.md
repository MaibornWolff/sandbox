# Shared settings

Use `settings` to share selected configuration between projects.
Sources live under `{config}/settings/`, not directly in your host home.
For example, `~/.claude/settings.json` selects `{config}/settings/.claude/settings.json`.

```toml
settings = [
  "~/.claude/settings.json",
  "~/.claude/commands/",
  { path = "~/.codex/config.toml", mode = "copy" },
]
```

See [configuration paths](CONFIGURATION.md#paths) to locate the source directory.

## Mount mode

Strings and `mode = "mount"` create read-write mounts.
Changes to existing mounted paths are immediate in both directions.

Mount entries accept glob patterns and exclusions:

```toml
settings = ["~/.claude/**", "!~/.claude/projects"]
```

New matching container paths are copied back when the container stops normally.
A forced stop can lose these new paths.

All projects share this source directory.
An agent can change settings used by another project.
Use copy mode for tools that replace configuration files atomically or when you do not want normal edits through the home path to update the source.

## Copy mode

At each container start, Sandbox copies the source and replaces the destination.
Changes through the copied home path do not update the source.
The next container start restores the host version.
This is not source isolation: the complete settings directory is also mounted read-write at `/etc/sandbox/settings`.
Container processes can change files there, including copy-mode sources and files not selected by settings patterns.

Copy entries require literal paths.
They do not accept glob or exclusion patterns.
A missing host source is skipped.
A copy failure stops startup.

A persistent parent can contain a copied child, but the copied destination cannot itself be a mount point:

```toml
settings = [{ path = "~/.codex/config.toml", mode = "copy" }]
persist_paths = [{ path = "~/.codex" }]
```

## Symbolic links and overlapping paths

Mount-mode settings must resolve inside the settings directory.
Sandbox stops startup if a selected link points outside it.
For an external dotfile source, remove the setting or its link and use an explicit mount:

```toml
mounts = ["~/dotfiles/example-tool:~/.example-tool:ro"]
```

Copy mode accepts relative links only when their targets stay inside the source settings directory.
It rejects absolute links.
Glob patterns do not traverse linked directories.

Mount-mode settings take precedence over overlapping persistent mounts.
Do not configure the same destination as an additional mount and a setting.

The link check and runtime mount are separate operations.
A compromised concurrent container could replace a checked path before mounting.
See [security](SECURITY.md#what-remains-exposed) before sharing settings between untrusted projects.
