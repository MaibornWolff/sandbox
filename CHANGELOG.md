# Changelog

## [Unreleased]

### Added

- Suggest similar commands when a command name has a typo. For example, `sandbox udpate` now shows `(Did you mean update?)`.

- Add `sandbox status --json` for tools. It prints a documented JSON format with a `schemaVersion`, so tools do not need to read Sandbox internals such as session marker files. See [machine-readable status](docs/SESSIONS.md#machine-readable-status).
- Add `sandbox status --all` to show the containers of all projects.
- Add `sandbox status --session <id>` to show one session by its `SANDBOX_SESSION_ID`. The first 6 or more characters of the ID are enough if no other session starts with them.
- Show the session ID and the start command of each session in `sandbox status`, and mark containers that are still starting.

### Changed

- Reject unknown `sandbox config` subcommands. Before, a typo such as `sandbox config updte` showed the merged configuration. Now Sandbox reports the unknown command, suggests a similar one, and exits with code 1.

- `sandbox status` now uses the runtime from your user configuration and no longer asks you to trust a project configuration. It now works in untrusted projects and in tools without a terminal.
  If you set `runtime` only in a project configuration, also set it in your user configuration.

### Fixed

- `sandbox stop` now shows `sessions unknown` and warns that open sessions will end when it cannot read the sessions of a container. Previously, it showed `no sessions`.

## [0.74.0] - 2026-11-24

### Added

- Install the MySQL, PostgreSQL, Redis, APCu, AMQP, Xdebug, PCOV, SOAP, Imagick, and LDAP extensions with the PHP tool. Xdebug starts with `xdebug.mode=off`. Enable it per command, for example `XDEBUG_MODE=debug php script.php`.
- Add support for session wrapper script, executed on each `sandbox` or `sandbox run` command. The wrapper is configured via a`[session]` `command_wrapper` config entry. The wrapper must be available inside the container. Use `--no-wrapper` to skip it for one session.
- Give each sandbox session a unique ID. Allowed host commands now receive four sandbox-specific environment variables:
  - `SANDBOX_SESSION_ID`: the session specific UUID.
  - `SANDBOX_PROJECT_DIR`: the host project root.
  - `SANDBOX_CONTAINER_NAME`: the resolved container name. (Not its runtime ID)
  - `SANDBOX_RUNTIME`: the container runtime, such as `docker`, `podman`, or `apple-container`.
- Select the container runtime as the first step of `sandbox init`. The prompt shows if each runtime is running, stopped, or not installed. It pre-selects your configured runtime, else the first running runtime, else "Auto-detect". If you select a runtime that is not running, Sandbox shows how to start it and continues.
- Set the container runtime without the prompt with `sandbox init --runtime <id>`. Valid IDs are `docker`, `podman`, `apple-container`, and `auto`. Sandbox writes the runtime to your user `config.toml`. `auto` keeps automatic detection. When you run `sandbox init` again with a different runtime, Sandbox shows the change in the usual diff review. `sandbox init`, `sandbox config update`, and `sandbox update` keep a runtime that is already set.

### Changed

- Read all container network logs with one container command in `sandbox network logs` and `sandbox network allow` instead of one command per log. This lowers the CPU load that each call places on the host and the container, which matters most for tools that poll these commands.
- Adjust default config template so settings under a table header are at the end of it. Uncommenting a table header at the previous position would have invalidated the config.

### Fixed

- Select a running container runtime when no runtime is configured. Previously, Sandbox selected the first installed runtime even when its daemon was stopped, for example Docker when only Podman was running. If no runtime is running, Sandbox still selects the first installed one.
- Check the configured runtime in the environment check at the end of `sandbox init`. Previously, the check ignored the `runtime` setting in your user `config.toml` and could report Docker when you had set Podman.
- Allow trusted projects to mount folders outside the project, such as a shared library in a sibling folder.
  The project root is the default mount, not a limit on the host files you can choose to share.
  Sandbox shows the resolved host paths, container destinations, and access modes for requested mounts before you approve the project configuration.
  If a symbolic link changes where a mount points, Sandbox asks for approval again.
  After updating, review and approve previously trusted projects once more.
  See the [security model](docs/SECURITY.md#project-trust-and-external-mounts).

## [0.73.2] - 2026-11-03

### Fixed

- Fix generated mise tool images on Podman 5.7 by using file-backed GitHub token secrets instead of unsupported environment-backed secret mounts.
- Install pnpm through mise instead of Corepack, so generated tool images build with Node.js 25 and later, which no longer bundle Corepack.

### Breaking Changes

- Generated Node.js tool images no longer enable Corepack or provide Yarn implicitly.
  Install Yarn explicitly if needed.
  Sandbox no longer provides Corepack's `packageManager` dispatch. Declare project tool versions in `mise.toml` and select `mise-env` with `sandbox init --project --tools node,pnpm,mise-env`.
  Preserve other tool selections when you update an existing project.

  Existing user Dockerfiles are not changed automatically.
  After updating the CLI, run this on the host from your project directory to migrate with an agent:

  ```bash
  sandbox assist "Migrate my existing user Dockerfile from Corepack to mise. Remove corepack enable. Replace Corepack pnpm installation commands with mise use -g pnpm at the same requested version, using pnpm@latest if no version was specified. Preserve the parent image, other tools, custom setup, and final USER root instruction. Ask me whether I want to keep Yarn. Install Yarn explicitly through mise only if I confirm. Check project Dockerfiles for the same changes and move any Corepack-managed project version requirements into mise configuration without discarding existing settings. Show me the changes before rebuilding."
  ```

  Review the changes, then run `sandbox build --user` to rebuild user and project images.
  See [custom tools and images](docs/LAYERED-IMAGES.md#javascript-package-managers) for manual migration.

## [0.73.1] - 2026-10-23

### Fixed

- Keep quiet `sandbox escape` commands connected after five seconds when Sandbox runs under Node.js.

### Security

- Remove the vulnerable `braces` dependency used for persistence and settings matching ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)). Existing patterns remain supported.
- Use the official Node.js 24 Debian image for internal container tools instead of Debian's Node.js 20 package. Node.js 24.22.1 includes fixes from the [October 2026 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) for:
  - **CVE-2026-111497:** Brotli decoder out-of-bounds write that permits remote code execution.
  - **CVE-2026-105482:** DNS name truncation at a NUL character.
  - **CVE-2026-105483, CVE-2026-106069, and CVE-2026-106072:** TLS certificate hostname validation bypasses.
  - **CVE-2026-105481:** acceptance of a keep-alive response sent before its request.
  - **CVE-2026-106074:** repeated random values from entropy caches saved in startup snapshots or single executable applications.
  - **CVE-2026-106073:** permission-model bypass through `fs.realpathSync()`.

  No direct attack vector has been identified in Sandbox's managed container tools. They do not decode Brotli, and bridge clients pin a session certificate with the fixed TLS identity `localhost`. The other affected APIs or usage patterns are not used. Exploitation through these tools therefore appears very unlikely, but this assessment does not guarantee that exploitation is impossible. It does not cover arbitrary project code, agent runtimes, or custom tools. In particular, Node.js HTTP clients such as `fetch()` can decode Brotli responses automatically.

  Run `sandbox upgrade` to rebuild affected images and recreate containers. Host and project runtimes still require separate updates.

### Breaking Changes

- The host CLI now requires Node.js 24.22.1 or a later Node.js 24 release. Upgrade Node.js on the host before installing this update.

## [0.73.0] - 2026-10-14

### Fixed

- Fix sessions that ended without an error when a browser stopped inside the sandbox, for example at the end of a Playwright run. The network proxy no longer crashes when a client half-closes a plain HTTP request. This crash stopped the container and every session in it.

### Security

- Prevent containers from mounting host paths through symbolic links in the settings directory. Every container can write this directory. A container could replace a mount-mode setting with a link, and the next container start of any project mounted the link target read-write. Sandbox now stops the container start when a selected mount-mode setting resolves outside `{config}/settings`.

### Breaking Changes

- Mount-mode settings can no longer link to paths outside the settings directory, for example links created by a dotfile manager. Links inside the settings directory still work. To migrate, remove the entry from `settings` or delete the link in `{config}/settings`. Then add a `mounts` entry to the global `config.toml`. The start error shows the entries for your links:

  ```toml
  # Before: {config}/settings/.example-tool -> ~/dotfiles/example-tool
  settings = ["~/.example-tool"]

  # After
  mounts = ["~/dotfiles/example-tool:~/.example-tool:rw"]
  ```

## [0.72.2] - 2026-10-12

### Fixed

- Fix image builds for Dockerfiles created by earlier Sandbox versions. Sandbox now updates legacy `FROM sandbox--base:latest` and `FROM sandbox--user:latest` references automatically.

## [0.72.1] - 2026-10-09

### Fixed

- Refresh older version caches to prevent incorrect Sandbox update notices.
- Remove the broken `-p` alias from `sandbox init` and `sandbox config update`. The global `-p, --port` option shadowed it, so both commands failed with "option '-p, --port <port>' argument missing". Use `--project`.

### Security

- Block proxy requests to unlisted IP addresses even when reverse DNS maps the address to an allowed domain. If affected, use the allowed hostname or add the IP address and port to `allow_network`, for example `"192.0.2.10:443"`.

## [0.72.0] - 2026-10-09

### Added

- Publish the first open-source release of Sandbox, a command-line tool for running coding agents and other development commands in isolated containers.
- Support Docker, Podman, and Apple `container` across macOS, Linux, and Windows environments.
- Limit agents to the current project and selected mounts. Restrict outbound traffic with a domain allowlist, keep selected data between sessions, and permit specific host commands when needed.
- Provide layered user and project configuration, customizable container images, reusable containers, setup diagnostics, and AI-assisted configuration help.

Install Sandbox and start an agent:

```bash
npm install -g @maibornwolff/sandbox
sandbox init
cd your-project
sandbox run claude # or: codex, copilot, pi, opencode
```
