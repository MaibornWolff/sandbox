# Contributing

Thank you for contributing to Sandbox.

## Before You Start

- Search existing issues and pull requests.
- Open an issue before you make a large behavior or architecture change.
- Report security vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## Development

Install Bun, Node.js 24.22.1 or later, and Docker or Podman. Then install the dependencies:

```bash
bun install
```

Run the complete local check before you submit a pull request:

```bash
bun check
```

`bun install` installs Git hooks. The pre-commit hook runs `bun check`. The pre-push hook runs `bun check`. Continuous integration (CI) runs `bun check`, the shell script tests, and the end-to-end tests, and it fails when a check changes a tracked file.

Run the shell script tests when your change affects files in `docker/`. They need `sh`, `bash`, and `zsh` on the host:

```bash
bun run test:shell
```

Run the end-to-end tests when your change affects container behavior:

```bash
bun run test:e2e
```

For test design, use the repository's [test-writing skill](.agents/skills/test-writing/SKILL.md).
For architecture and ownership, read the [architecture guide](contributing/ARCHITECTURE.md).
For merge gates and repository settings, read [CI and dependency updates](contributing/CI.md).

## Changes

- Add a failing test before you fix a bug.
- Add tests for new behavior.
- Update user documentation when behavior changes.
- Add user-visible changes to `CHANGELOG.md` under `Unreleased`. Include migration steps for breaking changes.
- Keep commits focused.
- Use conventional commit messages such as `feat: add command` or `fix: preserve exit code`.

## Dependency Updates

Renovate is the only bot that opens dependency update pull requests. GitHub
Dependabot security alerts stay enabled. Routine npm updates share one pull
request. GitHub Actions updates share a separate pull request, including major
versions. Major npm, container image, and runner updates need approval in the
Dependency Dashboard before Renovate opens a pull request.

Keep `typescript` on TypeScript 5. The check scripts and dependency-cruiser use
its JavaScript compiler API. Build and type-check commands use the separate
`typescript-native` alias for the TypeScript 7 native compiler. This separation
lets dependency-cruiser update without a package patch. Run the Docker and
Podman end-to-end jobs before you accept a runner image update.

## Releases

Maintainers start releases manually. See [release instructions](contributing/RELEASING.md) for
version selection, dry runs, npm setup, and recovery.

## Pull Requests

Describe the problem and the solution. Include the commands that you used to validate the change. A maintainer must review the pull request before merge.

By submitting a contribution, you agree that it can be released under the [BSD 3-Clause License](LICENSE).
