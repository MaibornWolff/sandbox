# Contributing

Thank you for contributing to Sandbox.

## Before You Start

- Search existing issues and pull requests.
- Open an issue before you make a large behavior or architecture change.
- Report security vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## Development

Install Bun, Node.js 24, and Docker or Podman. Then install the dependencies:

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

Read [docs/TESTING.md](docs/TESTING.md) for test design and test commands.

## Changes

- Add a failing test before you fix a bug.
- Add tests for new behavior.
- Update user documentation when behavior changes.
- Add user-visible changes to `CHANGELOG.md` under `Unreleased`. Include migration steps for breaking changes.
- Keep commits focused.
- Use conventional commit messages such as `feat: add command` or `fix: preserve exit code`.

## Releases

Maintainers start releases manually. See [docs/RELEASING.md](docs/RELEASING.md) for
version selection, dry runs, npm setup, and recovery.

## Pull Requests

Describe the problem and the solution. Include the commands that you used to validate the change. A maintainer must review the pull request before merge.

By submitting a contribution, you agree that it can be released under the [BSD 3-Clause License](LICENSE).
