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

Additional mounts are read-only by default.

Project configuration can mount paths outside the project after trust approval:

```toml
# .sandbox/config.toml
mounts = ["../shared-lib:/workspace/shared-lib", "/data/demo-cache:/cache:rw"]
```

Relative project sources resolve from the project root. Before approval, Sandbox shows all available project-configured mount sources as resolved host paths, with their container destinations and access modes. Symbolic links show their actual host targets. Missing sources are skipped with a warning.

Read-only mounts let container processes read the host files. Read-write mounts also let them change or delete those files. Trust approves the complete `.sandbox` configuration, not only its mounts. Global and CLI mounts are not included in the project approval list.

Sandbox asks for approval again when `.sandbox` contents or resolved project mount access changes. This includes a changed symbolic-link target or a previously missing source that becomes available. Rejecting approval exits without starting a container. If configuration contents or reviewed mount targets change while the approval prompt is open, Sandbox exits without saving approval. Run the command again to review the current paths. Use `--trust` or `SANDBOX_TRUST_ALL=1` only when you have reviewed the configuration and want to approve it without a prompt.

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
Relative sources in user configuration or CLI flags resolve from the host working directory.
Custom destinations might not exist on the host, so error paths can differ.

A read-only mount still exposes its contents, including credentials.
Do not mount your complete home directory or a container-runtime socket unless you accept the resulting access.
See [security](SECURITY.md).
