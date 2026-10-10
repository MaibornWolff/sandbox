# Changelog

## [Unreleased]

### Added

- Install the MySQL, PostgreSQL, Redis, APCu, AMQP, Xdebug, PCOV, SOAP, Imagick, and LDAP extensions with the PHP tool. Xdebug starts with `xdebug.mode=off`. Enable it per command, for example `XDEBUG_MODE=debug php script.php`.

### Fixed

- Refresh older version caches to prevent incorrect Sandbox update notices.

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
