# Sessions and containers

Run these commands from your project on the host:

```bash
sandbox
sandbox run claude
sandbox run npm test
sandbox run -- sh -c 'echo "$HOME"'
```

The first command opens an interactive [zsh](https://zsh.sourceforge.io/Doc/) shell.
`run` executes the supplied command.
Use `--` to separate Sandbox options from the command when needed.

## Reuse

Compatible concurrent sessions in the same project share a container.
Image, configuration, and Sandbox runtime changes can require a new container.
Containers stop automatically after all sessions end and the idle period expires.

To force a fresh container:

```bash
sandbox --no-container-reuse run claude
```

Sessions are not isolated from each other inside a shared container.
They share files and processes.
See [security](SECURITY.md).

## Quiet command output

```bash
sandbox run --silent npm test
```

`--silent` or `-s` hides Sandbox logs, not the command's output.
Input, terminal behavior, and the command exit code are preserved.
This option is only available on `run`.
It cannot be combined with `--verbose`.

## Status and stop

```bash
sandbox status
sandbox stop
sandbox stop --all
```

`status` shows running containers and active sessions.
`stop` targets the current project.
`--all` targets all Sandbox containers.
Stopping a container interrupts its sessions.

Use `sandbox container start` for foreground startup diagnostics, not a normal agent session.
It does not provide session environment values or host bridge capabilities.

## Terminal managers

For known agents, the host Sandbox process temporarily uses the agent name while the session runs.
Terminal managers can use this to identify the pane.
See [Herdr's agent documentation](https://herdr.dev/docs/agents/) for its detection behavior.
