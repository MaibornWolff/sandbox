# Project configuration

Use project configuration for requirements that belong to the repository.
Keep personal tools, credentials, and preferences in your user configuration.

From the project directory, run:

```bash
sandbox init --project
```

Run this from the intended project root.
The command creates `.sandbox/` in the current directory.
Choose image customization if you need project tools.
The prompts can preselect tools from detected project files.

Review `.sandbox/config.toml` for project settings.
If you selected image customization, also review `.sandbox/docker/Dockerfile` for project tools.

Commit these files if the team should share them.
See [custom images](LAYERED-IMAGES.md) for build commands and [configuration](CONFIGURATION.md) for merge rules.

## Trust

Project configuration can expose host files, allow network access, permit host commands, and run Dockerfile instructions.
Read the complete `.sandbox/` directory before trusting an unfamiliar repository.

Sandbox asks you to trust the directory before using it.
It asks again when a file changes.
An agent can edit these files because the project is writable.

For trusted automation, pass `--trust` or set `SANDBOX_TRUST_ALL=1`.
Both bypass the interactive trust check.
Do not use them for unreviewed repositories.

Trust records are stored in `{config}/trusted-projects.json`.
See [configuration paths](CONFIGURATION.md#paths) for `{config}`.

Run `sandbox config` to verify the merged result before starting the agent.
