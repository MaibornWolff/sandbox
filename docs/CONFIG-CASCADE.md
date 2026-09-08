# Configuration Cascade

Sandbox reads configuration from four layers. Each layer can extend or override an earlier layer.

## Configuration Layers

```mermaid
flowchart LR
  Defaults[Built-in defaults] --> User[User configuration]
  User --> Project[Project configuration]
  Project --> CLI[Command-line interface flags]
  CLI --> Result[Merged configuration]
```

The command-line interface (CLI) flags apply to one command only.

### 1. Built-in defaults

Sandbox provides defaults for settings such as `readonly`, `full_network`, `allow_network`, `allow_host_commands`, and `persist_paths`.

### 2. User configuration

`~/.config/sandbox/config.toml` applies to all projects.

### 3. Project configuration

`.sandbox/config.toml` contains project-specific settings.

### 4. CLI flags

Use flags such as `--mount`, `--env`, and `--allow-network` for one command.

## Merge Rules

### Arrays accumulate

Sandbox combines arrays from all layers.

```toml
# User configuration
allow_network = ["api.mycompany.com"]

# Project configuration
allow_network = ["database.mycompany.com:5432"]

# Merged result
allow_network = [
  # Built-in defaults remain here.
  "api.mycompany.com",
  "database.mycompany.com:5432",
]
```

A later layer can add array items. It cannot remove array items from an earlier layer.

The same rule applies to `allow_host_commands`. User and project rules form one effective host-command allowlist:

```toml
# User configuration
[[allow_host_commands]]
pattern = ["git", ["status", "diff", "log"]]

# Project configuration
[[allow_host_commands]]
pattern = ["bun", "run", "test:e2e"]
```

Sandbox appends trusted project rules after user rules. It removes structurally equal patterns and keeps the first rule. Rule tests run before duplicate removal. Project rules take effect only after the normal project trust check.

`sandbox escape --list` returns the effective patterns from the active session configuration. It prints compact JSON without rule tests or a heading:

```text
["git",["status","diff","log"]]
["bun","run","test:e2e"]
```

### Single-value settings override earlier values

The last specified value applies.

```toml
# User configuration
readonly = false

# Project configuration
readonly = true

# Merged result
readonly = true
```

Run `sandbox config` to inspect the merged configuration.

## Configuration Reference

See the [default user configuration](../templates/config.toml) and [project configuration](../templates/project-config.toml).

## Limitations

- Arrays cannot remove built-in items.
- Configuration cannot contain platform conditions.
- Sandbox does not recursively merge nested values.

## See Also

- [Architecture](./ARCHITECTURE.md)
- [Mounts](./MOUNTS.md)
- [Persistence](./PERSISTENCE.md)
- [Network Firewall](./NETWORK-FIREWALL.md)
