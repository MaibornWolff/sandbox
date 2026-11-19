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
sandbox status --all
sandbox status --session <id>
sandbox status --json
sandbox stop
sandbox stop --all
```

`status` shows running containers and active sessions of the current project.
`status --all` shows the running containers of all projects, grouped by project slug and project folder.
Containers from older Sandbox versions show only the slug.
`status --session <id>` searches all projects and shows only the container and the session with that ID.
Use the full `SANDBOX_SESSION_ID` or the first 6 or more characters of it.
A prefix must match exactly one session.
With `--all`, the result is the same.
If no session matches, or more than one session matches, `status` prints the reason to stderr, prints nothing to stdout, and exits with code 1.
`status --json` prints the same status as JSON for tools.
See [machine-readable status](#machine-readable-status).
`stop` targets the current project.
`stop --all` targets all Sandbox containers.
Stopping a container interrupts its sessions.

Use `sandbox container start` for foreground startup diagnostics, not a normal agent session.
It does not provide session environment values or host bridge capabilities.

## Machine-readable status

```bash
sandbox status --json
sandbox status --all --json
sandbox status --session <id> --json
```

`--json` prints one JSON document on stdout:

```json
{
  "schemaVersion": 1,
  "runtime": "docker",
  "containers": [
    {
      "name": "sandbox-my-app-1a2b",
      "project": { "slug": "my-app-1a2b", "dir": "/home/me/projects/my-app" },
      "image": "sandbox-user:latest",
      "startedAt": "2026-11-16T08:58:55.412Z",
      "ready": true,
      "hash": "b456f6b2807a",
      "sessions": [
        {
          "id": "6f1c0d3e-9a4b-4c2d-8e7f-1a2b3c4d5e6f",
          "pid": 74,
          "startedAt": "2026-11-16T09:02:10.000Z",
          "command": ["claude", "--resume"]
        }
      ]
    }
  ]
}
```

Document fields:

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | number | Version of the format, currently `1` |
| `runtime` | string | The runtime that status used: `"docker"`, `"podman"`, or `"apple-container"` |
| `containers` | array | Running Sandbox containers of the current project, or of all projects with `--all`. With `--session`, only the container of that session, with only that session in `sessions`. |

Container fields:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Container name |
| `project.slug` | string | Project slug |
| `project.dir` | string or `null` | Project folder on the host. `null` for containers from older Sandbox versions. |
| `image` | string | Image reference as the runtime reports it |
| `startedAt` | string or `null` | Container start time, ISO 8601 in UTC. `null` if the runtime reports no start time. |
| `ready` | boolean or `null` | `true` after the container finished its startup. `null` if Sandbox could not read the container state. |
| `hash` | string or `null` | Opaque configuration hash. `null` for containers without a hash. |
| `sessions` | array or `null` | Active sessions. `null` if Sandbox could not read the container state. |

Session fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | string or `null` | `SANDBOX_SESSION_ID` of the session. `null` for sessions from older Sandbox versions. |
| `pid` | number | Process ID of the session in the container |
| `startedAt` | string | Session start time, ISO 8601 in UTC, precise to the second |
| `command` | string array or `null` | Requested command and its arguments. With a configured [session command wrapper](CONFIGURATION.md#session-command-wrapper), the array starts with the wrapper. `null` for sessions from older Sandbox versions and for commands longer than about 64 KiB. |

Rules for tools:

- Read the document from stdout. Sandbox writes logs, warnings, and errors to stderr.
- Exit code 0 means that stdout contains the document.
  Without running containers, `containers` is an empty array.
- If status fails, for example because the runtime is unreachable, stdout is empty, stderr shows the error, and the exit code is 1.
  This also applies to `--session` with a value that matches no session or more than one session, or with fewer than 6 characters.
  A prefix is unique only among the sessions that Sandbox can read.
  If Sandbox could not read a container, the message for an unknown ID names it.
- `null` means unknown. It is not the same as `false` or an empty array.
- Ignore fields that you do not know. A new field keeps the `schemaVersion`.
  A renamed or removed field, or a field with a new type or meaning, increments the `schemaVersion`.
- Do not rely on the order of containers and sessions.
- Status uses the runtime from your user configuration.
  If your user configuration sets no runtime, status detects one.
  It never uses the `runtime` of a project configuration.
  One document contains only containers of this runtime.
  See [container runtimes](RUNTIMES.md).

## Terminal managers

For known agents, the host Sandbox process temporarily uses the agent name while the session runs.
Terminal managers can use this to identify the pane.
See [Herdr's agent documentation](https://herdr.dev/docs/agents/) for its detection behavior.
