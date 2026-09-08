# Data Flow

Sandbox uses five mechanisms to move data between the host and the container.

## Overview

| Mechanism | Purpose | Host to container example |
| --- | --- | --- |
| **Project mount** | Make the project available | `~/projects/myapp` to `~/projects/myapp` |
| **Additional mount** | Make another path available | `~/.aws` to `~/.aws` |
| **Persistent path** | Keep container data | `{data}/{project}/.claude` to `~/.claude` |
| **Settings synchronization** | Share settings | `{config}/settings/.claude/` to `~/.claude/` |
| **Host command escape** | Run an allowed host process | Container standard input and host process output |

`{config}` is the Sandbox configuration directory. `{data}` is the Sandbox data directory. Their locations depend on the host platform.

## Project Mount

Sandbox mounts the project at the same path in the container.

```
Host: ~/projects/myapp  ->  Container: ~/projects/myapp
```

Changes are immediate in both directions. The agent edits the host project files.

See [Mounts](./MOUNTS.md#project-mount).

## Additional Mounts

Use an additional mount for a path outside the project. Additional mounts are read-only by default.

```
Host: ~/.aws        ->  Container: ~/.aws        (read-only)
Host: /data/shared  ->  Container: /data/shared  (read-only)
```

See [Mounts](./MOUNTS.md#additional-mounts).

## Persistent Paths

A persistent path stores container data on the host.

```
Container: ~/.claude
Host:      {data}/{project}/.claude
```

Sandbox supports two storage scopes:

- Per-project storage keeps data separate for each project.
- Global storage shares data between projects.

See [Persistence](./PERSISTENCE.md).

## Settings Synchronization

Sandbox sends selected host settings to the container with `mount` or `copy` mode.

```text
Host:      {config}/settings/.claude/          -> mount -> ~/.claude/
Host:      {config}/settings/.codex/config.toml -> copy  -> ~/.codex/config.toml
```

A mount makes updates to existing settings immediate. Sandbox copies new matching mount paths to the host when the container stops normally.

A copy replaces the container destination at each container start. Container changes do not change the host source.

See [Settings Synchronization](./SETTINGS-SYNC.md).

## Host Command Escape

A normal execution session starts an authenticated broker on the host. Sandbox injects its endpoint, protocol, and token only into the matching container `exec` process.

```text
Container stdin  -> broker -> allowed host child stdin
Container stdout <- broker <- allowed host child stdout
Container stderr <- broker <- allowed host child stderr
```

The broker maps the container working directory to the same directory under the host project. It rejects paths outside the project. It uses the host process environment and does not copy the container environment.

The broker authorizes the original argument vector. It requires an exact executable and a complete rule match before it creates the host process. A regular expression can match only one complete argument. A repetition matcher has fixed minimum and maximum bounds.

The broker uses pipes. It does not provide a pseudo-terminal. It stops all active host children when the outer execution session ends.

## Overlapping Paths

Sandbox applies persistent mounts before mount-mode settings. A mount-mode setting takes precedence when these paths overlap.

A copy destination cannot be a direct mount point. A writable mounted parent is valid.

## Container Start

1. Mount the project.
2. Mount additional paths.
3. Mount persistent paths.
4. Mount mount-mode settings paths.
5. Replace copy-mode settings from the host source.
6. Stop startup if a copy fails.
7. Start required container services.
8. Mark the container as ready.
9. Start the session host-command broker.
10. Start the requested session with the broker connection data.

## Container Stop

1. Wait for all sessions to end.
2. Wait for the idle timeout.
3. Stop managed services and remaining sessions.
4. Copy new matching mount-mode settings to the host.
5. Stop the container.

Persistent paths already contain current data because they are bind-mounted from the host.

## See Also

- [Mounts](./MOUNTS.md)
- [Persistence](./PERSISTENCE.md)
- [Settings Synchronization](./SETTINGS-SYNC.md)
- [Configuration Cascade](./CONFIG-CASCADE.md)
