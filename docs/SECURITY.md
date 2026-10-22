# Security

Sandbox reduces the damage an agent can cause compared with running it directly on the host.
It does not make untrusted code safe in every case.

## What the boundary does

The container runtime separates agent processes and the container filesystem from the host.
Sessions run as a non-root user after privileged startup configures the environment and firewall.

Only exposed host paths are available through the container filesystem.
The complete project is exposed read-write by default, even when you start from a subdirectory.
This includes hidden files, `.git`, and secrets in the project.
Extra mounts are read-only unless configured otherwise.

The [network allowlist](NETWORK-FIREWALL.md) restricts outbound destinations.
[Project trust](PROJECTS.md) requires approval before Sandbox applies project configuration or Dockerfiles.

These controls reduce the reach of mistakes and prompt injection.
They do not detect malicious instructions or stop destructive edits to writable files.

## Project trust and external mounts

The project root defines the default mount, not the limit of approved host filesystem access.
A trusted project can request additional mounts, including parent folders, sibling folders, and symbolic links to paths outside the project.
This lets a project use shared code or data without copying it into the repository.

The trust decision covers the complete project configuration.
Before interactive approval, Sandbox shows the resolved host sources, container destinations, and access modes for the requested project mounts.
Changes to the configuration or to resolved project mount access require approval again.
A read-only mount still gives the agent access to the contents.
See [file mounts](MOUNTS.md#expose-another-host-path) for how to review and grant that access.

In a security review, distinguish approved access from access beyond the approved scope.
An external mount requested by a trusted project is not a vulnerability on its own.
Treat access without the required approval, access to a different target than the one approved, or write access through a read-only mount as potential vulnerabilities.
Preserve approved external mounts when fixing an approval or isolation failure.

## What remains exposed

- The agent can read secrets in project files, mounts, settings, persisted credentials, and forwarded environment variables.
- An allowed service can receive any data the agent can read.
  An allowlist is not a data-loss prevention system.
- Wildcard domains can permit data transfer in crafted subdomain names.
- The generated configuration allows many developer services and mounts selected host agent paths, including writable `~/.agents`.
  Review it before use.
- The generated environment sets `MISE_TRUSTED_CONFIG_PATHS=/` for [mise](https://mise.jdx.dev/cli/trust.html).
  Repository mise configuration is trusted inside the container without a separate prompt.
  This is independent of Sandbox's `.sandbox/` trust check.
- [Shared settings](SETTINGS-SYNC.md) and global persistent data connect projects.
  The complete settings directory is mounted read-write at `/etc/sandbox/settings`, even for copy-mode sources.
  Settings patterns do not hide other files in that directory.
  Do not treat projects that share it as separate security domains.
- [Clipboard access](CLIPBOARD.md) lets attached container processes read and replace the host clipboard by default.
- [Allowed host commands](HOST-COMMANDS.md) run with the host user permissions and environment.
  Broad rules, a mounted runtime socket, or unrestricted container-runtime commands can expose the whole host.
- Published ports expose container services through the runtime.
  Bind to a host loopback address where supported, and check the runtime's port behavior.
- Sessions in one container share a user, filesystem, and processes.
  Different session environment values do not isolate their secrets.

## What Sandbox does not defend against

Sandbox does not promise protection against container escapes, kernel or runtime vulnerabilities, or root escalation inside the container.
An attacker who gains container root can change protected state, including the firewall.
The underlying isolation depends on the selected runtime and host setup.
Do not assume a container has a separate kernel or the same boundary as a dedicated microVM.

Builds execute Dockerfile instructions and download third-party tools.
The session firewall is not a security boundary for image builds.
Review project Dockerfiles, dependency sources, and tools before you trust them.

An agent can edit the writable `.sandbox/` directory.
Sandbox asks for trust again when its contents change.
Review the changes rather than approving the next prompt automatically.
`--trust` and `SANDBOX_TRUST_ALL=1` bypass this review.

## Reduce access

- Commit or back up your work before long agent tasks.
- Start with `sandbox --readonly` when the agent only needs to inspect code.
- Remove unnecessary mounts and network entries from the configuration that defines them.
  A project configuration cannot remove user-level array entries.
- Forward only required credentials, with the smallest practical permissions.
- Set `clipboard = "disabled"` when host clipboard access is not needed.
  A trusted project can override this value.
  Check `sandbox config` before starting a session.
- Keep host-command rules narrow.
  Avoid rules for shells, interpreters, or scripts the agent can modify unless you accept their full host access.
- Keep the host, runtime, Sandbox, and tool images updated.

Report vulnerabilities through the repository's [security policy](../SECURITY.md).
