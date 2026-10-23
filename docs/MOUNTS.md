# File mounts

The agent works on your real project files.
Sandbox uses the nearest `.sandbox` marker or the detected Git root and mounts the complete selected project, including hidden files.
Git worktrees can also expose the main repository needed for Git operations.

Starting from a subdirectory does not limit access to that subdirectory.
The session starts in the corresponding working directory.

## Make the project read-only

```bash
sandbox --readonly run claude
```

This changes only the project mount.
Additional mounts, settings, and persistent paths can still be writable.

## Expose another host path

Additional mounts are read-only by default:

```bash
sandbox --mount ~/.aws run claude
sandbox --mount /data/shared:rw run claude
sandbox --mount /host/path:/container/path:ro run claude
```

Or add them to your configuration:

```toml
mounts = ["~/.aws:ro", "./shared-lib:ro"]
```

Formats:

- `/path` or `/path:ro`: same path, read-only.
- `/path:rw`: same path, read-write.
- `/source:/destination`: custom destination, read-only.
- `/source:/destination:rw`: custom destination, read-write.

`~` expands to the host home for a source and the container home for a destination.
Relative sources in project configuration resolve from the project root and must stay inside it, including resolved symbolic links.
Relative sources in user configuration or CLI flags resolve from the host working directory.
Use user configuration or a CLI mount for a sibling repository.
Missing sources are skipped with a warning.
Custom destinations might not exist on the host, so error paths can differ.

A read-only mount still exposes its contents, including credentials.
Do not mount your complete home directory or a container-runtime socket unless you accept the resulting access.
See [security](SECURITY.md).
