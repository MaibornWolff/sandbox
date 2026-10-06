# Architecture

Sandbox runs artificial intelligence (AI) coding agents in isolated containers. The system limits which host files and network services an agent can access.

## Design Goals

Sandbox has these design goals:

- Isolate agent processes from the host.
- Expose only selected host files.
- Restrict outbound network access.
- Keep selected data between container runs.
- Support user and project customization.
- Provide the same behavior across supported container runtimes.

Sandbox reduces risk from agent errors and prompt injection. It does not replace container runtime security.

## System Boundary

The container is the main trust boundary.

```mermaid
flowchart TB
  subgraph Host
    CLI[Sandbox command]
    Project[Project files]
    Settings[User settings]
    Data[Persistent data]
    Runtime[Container runtime]
    Broker[Session host-command broker]
    HostChild[Allowed host child]
  end

  subgraph Container
    Agent[Coding agent]
    Mounts[Project and additional mounts]
    Persistent[Persistent paths]
    SharedSettings[Shared settings]
    Firewall[Network firewall]
  end

  Services[Allowed network services]

  CLI --> Runtime
  Runtime --> Agent
  CLI --> Broker
  Agent -->|authenticated request| Broker
  Broker -->|allowlist match| HostChild
  Project -->|mount| Mounts
  Settings -->|mount and synchronize| SharedSettings
  Data -->|mount| Persistent
  Agent --> Mounts
  Agent --> Persistent
  Agent --> SharedSettings
  Agent --> Firewall
  Firewall --> Services
```

The host starts and controls the container. The agent runs inside the container as a non-root user.

## Main Responsibilities

### Host command

The host command:

- reads and merges configuration
- selects or builds the container image
- prepares a versioned, content-identified runtime cache
- creates mounts
- starts and stops containers
- starts agent sessions
- starts one authenticated host-command broker for each normal session
- reports status and diagnostic information

Update notices use the cached result from an earlier invocation. When a refresh is due, the host starts a detached update worker and does not wait for it. The worker has a bounded registry timeout. Its separate, atomically published cache prevents update checks from overwriting image or storage state. Failed attempts delay the next refresh.

### Container environment

The container environment:

- provides development tools
- runs the coding agent
- applies the configured filesystem access
- applies the configured network policy
- applies copy-mode settings before container readiness
- manages session lifetime
- synchronizes new mount-mode settings during a normal stop

### Sandbox runtime

The container-runtime component exposes two boundaries:

- `SandboxImageBuilder` checks local image availability, builds immutable images, and removes selected unused images.
- `SandboxRuntime` runs instances and owns runtime-local persistent storage.

Docker, Podman, and Apple `container` implement both boundaries. Sandbox modules use opaque instance and storage handles. They do not use runtime image stores, container names, or volume names. Docker and Podman share Docker-compatible code only inside the adapter.

Automatic instance cleanup preserves instances that are still being created. Runtime adapters report name conflicts through one semantic error. Callers can then retry without parsing runtime CLI messages.

The Apple adapter initializes newly allocated logical storage from image contents before instance creation. One helper copies all new volumes into staging directories. A storage lock prevents concurrent copies. Existing storage is retained, and warm starts do not repeat initialization.

A build returns a content identity that the selected runtime can start. Docker and Podman use the local image ID. Apple uses the image descriptor digest. Sandbox records this immutable identity for `--no-build` and reuse decisions.

An image record is not proof that the image is still in the runtime image store. When build inputs are unchanged, Sandbox checks the final image reference and content identity before it skips the build. This check does not require parent images. If the final image is missing or changed, Sandbox checks all layers through the image builder. The builder reuses matching local layers and builds missing or changed layers.

## Configuration Model

Sandbox reads configuration from four layers:

1. Built-in defaults
2. User configuration
3. Project configuration
4. Command-line interface (CLI) flags

Array values accumulate across layers. Single-value settings override earlier values.

This model separates shared preferences from project requirements. See [Configuration Cascade](./CONFIG-CASCADE.md).

## Filesystem Model

Sandbox exposes host data through explicit mounts.

- The project mount provides the agent workspace.
- Additional mounts expose selected host paths.
- Persistent paths keep selected container data.
- Mount-mode settings share user configuration through bind mounts.
- Copy-mode settings replace container paths from the host source at each start.

Host paths that are not mounted are not available inside the container.

See [Data Flow](./DATA-FLOW.md), [Mounts](./MOUNTS.md), and [Persistence](./PERSISTENCE.md).

## Image Model

Sandbox uses three image layers:

1. The base layer provides the operating system and common tools.
2. The user layer provides tools for all projects.
3. The project layer provides tools for one project.

A change rebuilds the affected layer and its child layers. This design keeps user and project customization separate.

Runtime program files are separate from image layers. `modules/sandbox-runtime` owns their package validation, identity, host cache paths, atomic publication, preparation leases, and cleanup. The leases prevent cleanup from removing a runtime between cache preparation and container creation. `modules/sandbox-containers` combines the cached runtime bind mount with a tool image at startup. Configuration does not construct these resources.

Runtime files are copied into the Sandbox data directory and mounted read-only. Runtime-only changes select a different container without rebuilding tool images. The container runtime does not need access to the host installation path.

See [Layered Images](./LAYERED-IMAGES.md).

## Network Model

Outbound network access uses a domain allowlist. The network system has three responsibilities:

- resolve allowed domains
- route supported traffic through a domain-aware proxy
- block direct outbound connections

Full-network mode keeps the network path but disables domain filtering.

A normal session can reach its host-command broker through the container runtime host name. Docker uses `host.docker.internal`, Podman uses `host.containers.internal`, and Apple uses `host.container.internal`. Apple also provides `host.docker.internal` as a compatibility alias. The Apple aliases use the reachable host gateway. Host services that listen only on localhost are not supported. The broker still requires its session token and command allowlist. Sandbox temporarily permits only the broker host and port for the agent user. It removes this network-policy exception when the session ends.

The Apple adapter owns its runtime-specific network behavior. Configuration selects `default`, `host`, or `host-ipv6` DNS once when it constructs the adapter. Host mode selects a guest-usable server from the current primary macOS DNS configuration. It does not use scoped resolvers or substitute public DNS. Resolver discovery, readiness, and runtime arguments stay private to the adapter. The guest DNS proxy provides exact Apple host aliases, without subdomain mappings. Sandbox does not add a privileged host setup workflow.

Each instance-startup scope shares one network snapshot between the compatibility check and container creation. The scope releases discovery helpers on reuse, creation, or failure. Independent scopes read current network and DNS state. User sessions run outside this scope.

In `host` and `host-ipv6` modes, the adapter revalidates shared builder DNS before each image build. Concurrent preparation calls share only the in-progress check. A process-owned filesystem lock serializes builder DNS preparation across Sandbox processes. Only the owner releases its lock. An abandoned lock requires manual recovery because filesystem checks cannot safely delete a lock that another process has replaced.

See [Network Firewall](./NETWORK-FIREWALL.md).

## Container Lifecycle

A normal session follows this sequence:

```mermaid
flowchart LR
  Config[Merge configuration] --> Image[Select or build image]
  Image --> Runtime[Prepare host runtime cache]
  Runtime --> Create[Create container]
  Create --> Security[Install IPv4 and IPv6 firewall policies]
  Security --> Apply[Apply copy-mode settings as non-root user]
  Security --> Services[Start container services]
  Apply --> Ready[Wait for settings and services]
  Services --> Ready
  Ready --> Session[Run session as non-root user]
  Session --> Idle{Sessions remain active?}
  Idle -->|Yes| Wait[Keep container running]
  Wait --> Idle
  Idle -->|No| Sync[Synchronize new settings]
  Sync --> Stop[Stop or remove container]
```

1. Merge configuration.
2. Select or build the image.
3. Prepare the runtime cache and mounts. Stop startup if runtime preparation fails.
4. Start the session host-command broker, then find a compatible container or create one.
5. For a new container, install both firewall policies before starting services and applying copy-mode settings. Apply settings as the non-root user while services become ready. Cancel and settle pending startup work if either operation fails.
6. Wait for container readiness and install the bounded session broker exception in one guest operation. `modules/sandbox-containers` owns this session preparation and its cleanup.
7. Run the requested command as the non-root user.
8. Remove the session broker exception. Stop the broker and its active host children when the execution ends.
9. Keep the container available while sessions remain active.
10. Synchronize new mount-mode settings during a normal stop.
11. Stop or remove the container according to the command and configuration.
12. After the session ends, remove old runtime caches when scheduled and no container references them.

Sandbox can reuse a compatible running container. A configuration, image, or runtime-content change requires a different container.

## Data Ownership

| Data | Owner | Lifetime |
| --- | --- | --- |
| Project files | Host project | Independent of the container |
| User settings | Host configuration directory | Shared between projects |
| Per-project persistent data | Sandbox runtime or Sandbox data directory | One project |
| Global persistent data | Sandbox runtime or Sandbox data directory | Shared between projects |
| Temporary container data | Container | Until the container is removed |
| Image layers | Sandbox image builder | Until scoped image cleanup |
| Runtime package cache | Sandbox runtime component | Until unused and removed by scheduled cleanup |

## Security Boundaries

Sandbox relies on these boundaries:

- The container runtime isolates processes and the container filesystem.
- Explicit mounts define host filesystem access.
- The network allowlist defines external network access.
- The non-root container user limits changes to protected container state.
- Project configuration requires trust before Sandbox applies it.
- The host-command broker checks a session token and the complete argument vector before it starts a host process.
- Each host-command rule requires an exact executable and must consume all arguments.
- Regular expressions match one complete argument. Repetition has a configured minimum and maximum.

Host command escape is an explicit exception to the container boundary. Each allowed command runs with the host user permissions and host environment. The broker exists only for the matching normal execution session. It does not start for `sandbox container start`. An allowed HTTP or HTTPS URL can disclose data through the URL.

These boundaries do not prevent every attack. An allowed domain can receive data. A writable project can change project configuration for a later run. A container runtime vulnerability can break isolation.

## Related Documents

- [Configuration Cascade](./CONFIG-CASCADE.md)
- [Data Flow](./DATA-FLOW.md)
- [Layered Images](./LAYERED-IMAGES.md)
- [Mounts](./MOUNTS.md)
- [Network Firewall](./NETWORK-FIREWALL.md)
- [Persistence](./PERSISTENCE.md)
- [Settings Synchronization](./SETTINGS-SYNC.md)
- [X11 Clipboard Setup](./X11-SETUP.md)
