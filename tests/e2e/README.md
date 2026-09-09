# Docker-Backed End-to-End Tests

These tests verify behavior that requires a real container boundary. They do not repeat complete command or business-rule matrices.

## Prerequisites

Install these dependencies:

- a Docker-compatible runtime
- GNU `timeout` or `gtimeout`
- the util-linux `script` command with support for `-q -e -c`
- Git

Allow outbound Domain Name System (DNS) and secure Hypertext Transfer Protocol (HTTPS) traffic for network and tool-installation fixtures.

Run the suite on a host that can create container images, containers, networks, and volumes:

```bash
bun run test:e2e
```

The command creates a temporary runtime package. It builds the command-line interface (CLI) directly into that package. All tests use this immutable snapshot.

Set a different runtime when required:

```bash
SANDBOX_TEST_RUNTIME=podman bun run test:e2e
```

Run the test command directly to test an existing CLI:

```bash
SANDBOX_BIN=/absolute/path/to/main.js bun test --timeout 30000 tests/e2e/
```

Set `SANDBOX_TEST_TMP` to use another runtime-shared temporary directory. The default directory is `test-tmp/e2e` in the repository.

## Fixture Rules

- Create one temporary project for each test file.
- Call `cleanupProject()` after the tests in the file.
- Do not run a scenario against the repository project.
- Use the isolated user configuration from the test harness.
- Trust only the project configuration that the test harness creates.
- Keep built images between tests to reuse the image-layer cache.

External fixtures are part of the tested boundary. The network tests require their declared public domains and DNS records. The mise and PHP tests require equivalent package sources and generated Dockerfiles. Investigate a fixture failure before you replace the fixture.

## Boundary Inventory

- `container-settings.test.ts`: existing and missing mount-mode and copy-mode settings, ownership, IDE bridge readiness, synchronization, and atomic replacement
- `container-start-signals.test.ts`: interrupt and termination signal behavior through the host CLI, runtime CLI, and container entrypoint
- `image-migration.test.ts`: migration of a legacy project Dockerfile
- `image-runtime-package.test.ts`: image-owned CLI and container tools without a host installation mount
- `init-mise.test.ts`: mise image build and tool installation
- `init-php.test.ts`: PHP and Composer image build
- `mounts-symlink.test.ts`: symbolic-link resolution and read-only bind mounts
- `network.test.ts`: proxy and DNS enforcement, full-network mode, and diagnostics
- `persistence.test.ts`: persistent data after container recreation
- `pid1-lifecycle.test.ts`: concurrent sessions, orphan process cleanup, signals, and idle shutdown
- `ports.test.ts`: a container HTTP service published on a host port
- `readonly-workspace.test.ts`: read-only project mount enforcement
- `security.test.ts`: network, privilege, filesystem, and mount-isolation boundaries
- `stdin.test.ts`: piped standard input and a real pseudo-terminal

Use the deterministic application harness for exhaustive business rules and state combinations.
