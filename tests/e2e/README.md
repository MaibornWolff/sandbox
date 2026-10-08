# Container-Backed End-to-End Tests

These tests verify behavior that requires a real container boundary. They do not repeat complete command or business-rule matrices.

## Prerequisites

Install these dependencies:

- Docker, Podman, or Apple `container` 1.4.1 or newer
- macOS 26 or newer for Apple `container`
- Node.js 24 or newer
- GNU `timeout` or `gtimeout`
- util-linux `script` on Linux, or the built-in BSD `script` on macOS
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

## GitHub Actions

CI runs the full suite in separate Docker and rootless Podman jobs on Ubuntu 24.04. Both jobs build images with the selected runtime. The workflow token permits GitHub downloads during image builds without an anonymous API rate limit.

Use the CI workflow's manual trigger to test a branch before you open a pull request. Branch pushes do not start CI. Pull requests and pushes to `main` start CI automatically.

Apple containers require a self-hosted Apple silicon runner with macOS 26 or newer. GitHub-hosted macOS runners [do not support nested virtualization](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). The [Apple runtime requirements](https://github.com/apple/container#requirements) also exclude Linux runners. CI therefore tests Docker and Podman only.

## Apple Runtime Selection

The test harness creates isolated configuration. It does not use your normal user or repository configuration. Select Apple and its DNS mode explicitly:

```bash
SANDBOX_TEST_RUNTIME=apple-container \
SANDBOX_TEST_APPLE_DNS=host \
SANDBOX_E2E_APPLE=1 \
SANDBOX_E2E_APPLE_HOST=1 \
bun run test:e2e
```

`SANDBOX_TEST_APPLE_DNS` accepts `default`, `host`, or `host-ipv6`. If you omit it, the runtime default applies. This selector does not change the product default.

`SANDBOX_E2E_APPLE=1` enables the Apple no-build and exact host-alias tests. These tests use the DNS mode selected by the test harness. Provider-specific selection and readiness logic use deterministic tests. The E2E suite does not require the host IPv6 DNS proxy.

For a focused test, build the CLI first and run only the required file or test name:

```bash
SANDBOX_TEST_RUNTIME=apple-container SANDBOX_TEST_APPLE_DNS=host \
bun test --timeout 30000 tests/e2e/network.test.ts \
  --test-name-pattern 'allowed domain resolves via DNS'
```

## Apple Host DNS Regression

The host DNS regression requires Apple `container` on macOS 26 or newer. It uses the primary macOS DNS server, not the runtime DNS proxy. If the shared builder uses a different resolver, wait for active builds to finish before you stop it. The test does not stop an active builder automatically.

After you build the CLI, run the focused test:

```bash
SANDBOX_E2E_APPLE_HOST=1 bun test tests/e2e/apple-host-dns.test.ts
```

The test installs and executes just, fetches the mise signing key through restricted guest DNS, and checks that direct public DNS is blocked.

## Fixture Rules

- Create one temporary project for each test file.
- Call `cleanupProject()` after the tests in the file.
- Do not run a scenario against the repository project.
- Use the isolated user configuration from the test harness.
- Trust only the project configuration that the test harness creates.
- Keep built images between tests to reuse the image-layer cache.

External fixtures are part of the tested boundary. The network tests require their declared public domains and DNS records. The mise and PHP tests require equivalent package sources and generated Dockerfiles. Investigate a fixture failure before you replace the fixture.

## Clipboard Qualification

`clipboard.test.ts` uses a native clipboard fixture that reads and writes files. It does not read or replace the real host clipboard.

The separate host metadata test requires `SANDBOX_APPROVE_HOST_CLIPBOARD=1`. Set this variable only after approval for host clipboard access. This test reads supported-format metadata. It does not publish content or qualify native image conversion.

Do not use the isolated tests as evidence that native clipboard support is qualified.

## Boundary Inventory

- `container-settings.test.ts`: existing and missing mount-mode and copy-mode settings, ownership, IDE bridge readiness, synchronization, and atomic replacement
- `container-start-signals.test.ts`: interrupt and termination signal behavior through the host CLI, runtime CLI, and container entrypoint
- `runtime-package.test.ts`: read-only runtime caches, unchanged tool images after runtime edits, concurrent starts, and active-session version isolation
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
