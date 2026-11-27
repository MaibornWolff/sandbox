# Updates and cleanup

## Update the CLI

For an npm installation:

```bash
sandbox update
```

Sandbox checks the configured npm registry and asks before installing the latest version through npm.
If configuration templates changed, it starts the configuration update flow.

For a [pnpm](https://pnpm.io/cli/add) or [Bun](https://bun.sh/docs/pm/cli/install) installation, update with the same package manager:

```bash
pnpm add -g @maibornwolff/sandbox@latest
# or: bun install -g @maibornwolff/sandbox@latest
```

Do not use `sandbox update` for these installations.
It can create a second npm-installed copy instead of replacing the active one.
After a package-manager update, review the latest configuration templates with the commands below.

To review new templates separately:

```bash
sandbox config update
sandbox config update --project
```

For each changed file, you can overwrite it, open a diff editor, or skip it.
Review access settings before accepting new defaults.

## Update tools and agents

```bash
sandbox upgrade
sandbox upgrade --user
sandbox upgrade --project
```

The CLI update and tool-image update are separate.
`upgrade` rebuilds images with fresh package steps.
Use `--user` for user and project tools, or `--project` for project tools.
Use `sandbox build` for ordinary cached rebuilds after Dockerfile changes.

Verify the updated tool in a new session.

## Cleanup

```bash
sandbox clean
```

The command removes eligible stopped Sandbox containers, unused Sandbox images, and old runtime caches in the selected runtime.
It does not perform a global runtime image prune.

- `sandbox clean --all` includes running containers and interrupts active work.
- `sandbox clean --data` also deletes current-project bind data, the shared cache volume, and configured named volumes.
  This can remove project logins and history, plus shared data used by other projects.
  Global bind-persisted data is retained.

Read the prompt before confirming.
Back up data you need before using `--data`.
See [data paths](CONFIGURATION.md#paths) for bind storage.
Use your runtime's backup procedure for named volumes.
Files in the mounted project are separate from persistent Sandbox storage.
