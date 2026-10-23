# Changelog

## [Unreleased]

### Security

- Preserve existing file permissions when updating configuration and state files. New files are readable and writable only by their owner.
- Keep environment values for Docker and Podman containers out of the runtime command line. Sandbox now passes only variable names as `-e NAME` and sends the values through the process environment, so API keys and the host bridge token no longer appear in `ps` output or `/proc/<pid>/cmdline`.
- Reject invalid host names in `sandbox network allow`. Names from sandbox DNS and proxy logs can no longer inject extra entries or break `config.toml`.
- Block proxy requests to allowed domains that resolve to loopback, link-local, or private network addresses. Host access names and explicit IP entries in `allow_network`, for example `"192.168.1.5:443"`, stay allowed.
- Stop allowed host commands from running executables placed in the project directory on Windows. `git` host commands now ignore repository hooks and `core.fsmonitor`, so a sandboxed process cannot plant code that `sandbox escape git ...` runs on the host. Keep `git` rules narrow: repository config such as `diff.external` or `filter.*.clean` can still start other programs.
- Keep configured values out of the warning about undefined `$VARIABLE` references in `env` entries. The warning now names only the entry and the missing variable.

### Fixed

- Keep `config.toml` intact when `sandbox network allow` adds domains. Sandbox now places a new `allow_network` key before the first table, ignores closing brackets inside comments, writes the file in one step, and stops instead of replacing the file when it cannot read the existing content.
- Keep the Sandbox state file intact. State is written in one step, and one invalid stored field no longer discards the other fields.
- Detect missing containers from the `No such object` message that `docker inspect` and `podman inspect` print. Session reuse and cleanup now handle containers that stopped and were removed during startup.
- Report the real exit code and output from `sandbox escape` when the host command exits before piped input finishes, for example `echo data | sandbox escape git rev-parse HEAD`. Earlier this failed with "Host command escape protocol failed." and exit 1.
- Mount the correct project root for Git submodules, repositories with a separate Git directory, and linked worktrees of bare repositories. Git lookup failures such as "dubious ownership" are now visible with `--verbose`.
- Find stopped containers with `sandbox clean` on the Apple container runtime, and wait for Apple containers that are still stopping instead of treating their state as unknown.
- Report an invalid `config.toml` in `sandbox doctor` as a diagnostic error instead of crashing.

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
