# CI and dependency updates

Read this guide when changing checks or repository merge settings.
Workflows live in [`.github/workflows/`](../.github/workflows/).

## Merge gates

Pull requests run fast validation, shell tests, dependency security, license checks, and [CodeQL](https://codeql.github.com/docs/).
Container E2E tests run for Renovate pull requests and when a maintainer adds `run-e2e`.
Main pushes run both Docker and Podman E2E jobs.

For a branch without a pull request, dispatch CI with `run_e2e` enabled.
That run does not replace pull-request or main-push checks.

Before enforcing required checks on `main`, configure a dedicated release identity.
The [release finalization step](RELEASING.md#one-time-setup) pushes a metadata commit directly after npm publication.
That new commit has no CI results yet, so required checks would block the push after publication.
Give only the release identity a bypass for this operation.
Do not give every GitHub Actions workflow a bypass.

Then require these status checks on `main`:

- `Merge gate`.
- `License and SBOM`.
- `Analyze JavaScript and TypeScript`.

Require up-to-date branches.
Do not require conditional E2E job names for every pull request.
`Merge gate` permits skipped E2E where appropriate, but blocks failed requested E2E and requires both jobs for Renovate.

Repository files do not configure GitHub branch rules or grant Renovate merge permissions.
Set those separately without bypassing review or required checks.

## Dependency updates

[Renovate](https://docs.renovatebot.com/) waits seven days after a dependency release where timestamps are available.
Versions without timestamps are held.
The delay is not a guarantee against compromised releases.

Renovate evaluates CI results itself with `platformAutomerge: false`.
Keep CI, compliance, and CodeQL workflows enabled for every Renovate pull request.
This client-side gate does not replace server-side protection for manual merges or direct pushes.

Only npm minor and patch updates can automerge.
Major updates require approval.
Actions and runner changes do not automerge.
Security-fix updates can bypass the delay, but require human review and cannot automerge.

The required security audit checks the resolved lockfile, including development and transitive dependencies.
Critical non-denial-of-service findings and scanner errors block merging.
Denial-of-service advisories are ignored.
Other severities are reported as warnings.
Advisory coverage is not a complete security guarantee.

For a different Renovate bot identity, update the workflow identity condition before enabling automerge.

## Release checks

Releases reuse successful main-push checks for the exact source commit.
The saved npm candidate also passes installation and publication dry-run tests.
See [releasing](RELEASING.md) for publication, candidate reuse, and recovery.
