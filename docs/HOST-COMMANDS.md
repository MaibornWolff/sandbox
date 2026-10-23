# Allowed host commands

Use `sandbox escape` inside an attached session for operations that must run on the host.
No host commands are allowed unless a trusted configuration rule matches them.

Every allowed command runs with your host permissions and host environment.
It can access files outside the container.
A rule for a writable project script gives the agent whatever host access that script can exercise.

## Add a narrow rule

In the user or project configuration:

```toml
[[allow_host_commands]]
pattern = ["git", ["status", "diff", "log"]]
test_match = [["git", "status"]]
test_no_match = [["git", "push"], ["git", "status", "--short"]]
```

Then, inside Sandbox:

```bash
sandbox escape --list
sandbox escape -- git status
```

The complete original argument list must match.
Sandbox does not run it through a shell.
The command runs in the host directory that matches the container working directory.
Paths outside that project are rejected as working directories.

`--list` prints each effective pattern as compact JSON.
User and trusted project rules accumulate.
Duplicate patterns keep the first rule.

## Matcher reference

The first segment must be an exact, non-empty executable string.
Later segments can be:

- An exact string: `"status"`.
- `"?"`: one complete argument.
- `"*"`: zero or more complete arguments, including in the middle of a pattern.
- An array: alternatives for one argument, such as `["status", "diff"]`.
- A regex object: `{ regex = 'profile-[0-9]+', flags = "i" }`.
  It matches one complete argument.
  The expression is automatically anchored.
- A repeat object: `{ repeat = ["--verbose", "--quiet"], min = 1, max = 2 }`.
  Both bounds are required.
  The maximum cannot exceed 32.

`?` can occur in an alternative or repeat matcher.
`*` can only be a top-level segment.
Strings such as `"file*"` are literal, not glob patterns.
To match literal wildcard arguments, use `{ regex = '\\*' }` or `{ regex = '\\?' }`.

`test_match` and `test_no_match` contain complete argument lists.
Sandbox rejects the configuration if a test has the wrong result.
Keep each inline TOML matcher object on one physical line.

## Limits and risks

The bridge exists only while the outer attached session is active.
It is not available with bare `sandbox container start`.
Host commands use pipes, not a pseudo-terminal.
The bridge stops active host children when the outer session ends.

Avoid broad permissions for shells, interpreters, runtime commands, or commands that accept arbitrary file paths.
An allowed URL can disclose data through its path or query.
Restrict URL rules to trusted destinations when required.

## Migrate old rules

String rules are no longer supported:

```toml
# Old
allow_host_commands = ["bun run test:e2e"]
```

Replace them with structured rules:

```toml
[[allow_host_commands]]
pattern = ["bun", "run", "test:e2e"]
```

Review each old wildcard.
A new `"*"` allows any number of complete arguments.
