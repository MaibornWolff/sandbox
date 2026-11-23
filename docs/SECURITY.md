# Security

**Sandbox limits what an agent can reach.** It reduces the damage an agent can cause compared with running it directly on the host.
It does not make untrusted code safe or protect data from an agent you give access to.

## What the boundary does

- **Filesystem.** The container filesystem exposes only the host paths made available to it.
  The complete project is writable by default, including hidden files, `.git`, and project secrets.
  Starting in a subdirectory does not narrow that access.
- **Network.** The [network allowlist](NETWORK-FIREWALL.md) limits where outbound connections can go.
- **Privileges.** Sessions run as a non-root user after privileged startup configures the environment and firewall.
- **Project configuration.** [Project trust](PROJECTS.md) requires approval before Sandbox applies project settings or Dockerfiles.

These controls reduce the reach of mistakes and prompt injection.
They do not detect malicious instructions or stop destructive edits to writable files.

## Project trust and external mounts

**The project root is the default mount, not the limit of access you can approve.**

- **Why allow external mounts?** A project can use a shared library, a parent workspace, or local data without copying it into the repository.
  A path outside the repository can be necessary for the work, and a path inside it can still contain secrets.
  Repository location alone does not tell Sandbox which files you intend to share.
- **What do you approve?** Trust applies to the complete project configuration, not just the mounts.
  Before interactive approval, Sandbox shows the resolved host sources, container destinations, and access modes for the requested project mounts.
  For a symbolic link, review the target, not just the link name.
- **When does approval expire?** Sandbox requires approval again when the project configuration or resolved project mount access changes.
  This prevents approval for one folder or access mode from carrying over to another.
- **What can the agent do?** A read-only mount protects files from changes through that mount, not from being read or copied.
  A read-write mount also lets the agent change or delete files.
  Share the smallest folder and use the least access the task needs.

See [file mounts](MOUNTS.md#expose-another-host-path) for setup and review steps.

### How to review security changes

- **Intended access:** A trusted project mounts the parent folder, sibling folder, or external symbolic-link target that the user approved.
  The fact that the target is outside the repository is not a vulnerability on its own.
- **Potential vulnerability:** Sandbox applies access without the required approval, exposes a different target, or allows writes through a read-only mount.
  State what access the user approved and what extra access the agent received.
- **Fix the boundary, not the feature.** Preserve approved external mounts when fixing an approval or isolation failure.

## What remains exposed

- **Secrets.** The agent can read secrets in project files, mounts, settings, persisted credentials, and forwarded environment variables.
- **Allowed destinations.** An allowed service can receive any data the agent can read.
  An allowlist is not a data-loss prevention system.
  Wildcard domains can also permit data transfer in crafted subdomain names.
- **Generated configuration.** Sandbox allows many developer services and mounts selected host agent paths, including writable `~/.agents`.
  Review the generated configuration before use.
- **Tool configuration.** The generated environment sets `MISE_TRUSTED_CONFIG_PATHS=/` for [mise](https://mise.jdx.dev/cli/trust.html).
  Repository mise configuration is trusted inside the container without a separate prompt.
  This is independent of Sandbox's `.sandbox/` trust check.
- [Shared settings](SETTINGS-SYNC.md) and global persistent data connect projects.
  The complete settings directory is mounted read-write at `/etc/sandbox/settings`, even for copy-mode sources.
  Settings patterns do not hide other files in that directory.
  Do not treat projects that share it as separate security domains.
- [Clipboard access](CLIPBOARD.md) lets attached container processes read and replace the host clipboard by default.
- [Allowed host commands](HOST-COMMANDS.md) run with the host user permissions and environment.
  Broad rules, a mounted runtime socket, or unrestricted container-runtime commands can expose the whole host.
- **Published ports.** The runtime can expose container services on the host.
  Bind to a host loopback address where supported, and check the runtime's port behavior.
- **Shared sessions.** Sessions in one container share a user, filesystem, and processes.
  Different session environment values do not isolate their secrets.

## What Sandbox does not defend against

- **Container escapes and root escalation.** Sandbox relies on the runtime and host for isolation.
  Kernel and runtime vulnerabilities can break that boundary.
  A container does not necessarily have a separate kernel or the same boundary as a dedicated microVM.
  Container root can change protected state, including the firewall.
- **Image builds.** The session firewall does not protect builds that execute Dockerfile instructions and download third-party tools.
  Review project Dockerfiles, dependency sources, and tools before you trust them.
- **Automatic approval.** An agent can edit the writable `.sandbox/` directory.
  Review any changes when Sandbox prompts again.
  `--trust` and `SANDBOX_TRUST_ALL=1` bypass the interactive review.

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
