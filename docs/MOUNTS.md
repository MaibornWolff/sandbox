# Mounts

Sandbox uses mounts to make host files available in the container.

## Project Mount

Sandbox detects the project root from a `.git` or `.sandbox` directory. It mounts the complete project at the same path in the container.

```bash
cd ~/projects/myapp/src
sandbox
pwd  # -> ~/projects/myapp/src
```

If you start Sandbox from a project subdirectory, the container starts in the same subdirectory. Error messages can therefore use host paths that your editor can open.

## Additional Mounts

Use the configuration file or the command-line interface (CLI) to mount a path outside the project.

| Format | Result |
| --- | --- |
| `/path` | Mount at the same path as read-only |
| `/path:ro` | Mount at the same path as read-only |
| `/path:rw` | Mount at the same path as read-write |
| `/src:/dst` | Mount at `/dst` as read-only |
| `/src:/dst:rw` | Mount at `/dst` as read-write |
| `~/path` | Expand `~` to the host home directory |
| `./path` | Resolve the path from the project root |

Mounts are read-only unless you specify `rw`.

```bash
sandbox --mount ~/.aws
sandbox --mount /data/shared:rw
sandbox --mount /host/path:/container/path:ro
```

A custom destination can appear in container error messages. That path might not exist on the host.

## See Also

- [Architecture](./ARCHITECTURE.md)
- [Persistence](./PERSISTENCE.md)
- [Configuration Cascade](./CONFIG-CASCADE.md)
