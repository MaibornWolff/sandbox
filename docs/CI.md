# CI and dependency updates

## Pull request checks

Every pull request to `main` runs fast checks, shell tests, a dependency audit,
license and package checks, and CodeQL analysis.

Docker and Podman end-to-end (E2E) tests run automatically on pull requests
created by the `renovate[bot]` account. Other pull requests do not run E2E tests
unless a maintainer adds the `run-e2e` label. Each new commit reruns the applicable
checks. Remove the label to stop requesting E2E on later commits.

For a branch without a pull request, manually start the CI workflow on that
branch with **run_e2e** enabled. This branch run does not replace pull request
checks or main-push checks.

The `Merge gate` job requires fast checks and dependency security to succeed.
For Renovate pull requests, it also requires both E2E jobs to succeed. For other
pull requests, skipped E2E is permitted, but failed requested E2E blocks merging.
All main pushes run both E2E jobs.

## Required GitHub settings

Configure the rules for `main` to require these status checks:

- `Merge gate`
- `License and SBOM`
- `Analyze JavaScript and TypeScript`

Require branches to be up to date before merging. Do not mark the conditional
E2E job names as required checks for every pull request. `Merge gate` applies
that requirement only when needed.

Renovate must have permission to merge pull requests. Existing review rules
still apply. Do not grant a bypass that allows Renovate to skip required checks.
A self-hosted Renovate identity needs an explicit update to the bot identity
condition in CI before automerge is enabled for it.

The repository configuration does not change GitHub rules or install Renovate.
Configure those settings before enabling unattended merges.

## Renovate policy

Renovate waits seven days after each dependency version's release. Versions
without a release timestamp are held. The waiting period applies where the
datasource provides release timestamps, not to immutable digests as a separate
supply-chain guarantee. A waiting period reduces exposure to newly compromised
versions but does not prevent zero-day vulnerabilities.

Only npm patch and minor updates are eligible for automerge. Major updates
require Dependency Dashboard approval and manual merging. GitHub Actions and
runner updates are not automatically merged. Renovate rebases branches when
`main` advances so checks run against the current base.

GitHub and OSV vulnerability alerts propose fixes for existing vulnerable
dependencies. They are not a complete filter for all proposed upgrade versions.
The required `bun run security` check audits the resolved lockfile, including
development and transitive dependencies. Critical findings block merging, except denial-of-service findings, which are
ignored. Other high, moderate, and low findings remain visible as non-blocking
warnings. Scanner and registry errors block merging. This protection depends on advisory
database coverage and the data available when the audit runs.

Security-fix updates can bypass Renovate's normal release-age delay. They require
human review and are not eligible for automerge. Review the target release age
before approving a security fix. An urgent exception to the seven-day policy
must be an explicit maintainer decision.

## Releases

Releases reuse successful main-push checks for the exact source commit. They
still test installation and publishing from the saved npm package. See
[Releasing Sandbox](RELEASING.md) for approval, candidate reuse, and recovery.
