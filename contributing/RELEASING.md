# Releasing Sandbox

Read this guide before publishing or recovering a release.
Publication to [npm](https://docs.npmjs.com/) starts manually through the [GitHub Actions](https://docs.github.com/en/actions) [Release workflow](../.github/workflows/release.yml).
Do not publish without maintainer approval.

## Prepare the notes

Write user-visible changes under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md).
Include capabilities, fixes, security changes, and migration steps.
Exclude CI, tests, internal implementation, and development workflows.
Do not generate notes from commit messages or change released sections except to correct facts.

Merge reviewed notes into `main` without changing the package version.
The workflow prepares the version and dated notes, then commits them after publication.

## Version selection

The workflow reads commits after the current `v<version>` tag, using the version in `package.json`.
The checkout needs full history and tags.
Before the first release, it reads the full history.

- `feat:` or `feat(scope):` selects a minor release.
- `!`, `BREAKING CHANGE:`, or `BREAKING-CHANGE:` also selects a minor release while the project remains in `0.x`.
- Other commits select a patch release.
- The highest increment wins.
- No new commits, or a missing current tag after earlier releases, stops preparation.

Stay in `0.x` until maintainers adopt a stable `1.0.0` policy.

## One-time setup

1. Confirm that the npm organization owns `@maibornwolff` and the maintainer can publish `@maibornwolff/sandbox` publicly.
2. Create the GitHub environment `npm-production`, restricted to `main`.
   Manual workflow dispatch authorizes publication, so a second environment approval is not required.
3. Permit the release identity to push metadata to `main` and create `v0.*` tags.
   If repository rules block `GITHUB_TOKEN`, configure a narrowly scoped `RELEASE_GITHUB_TOKEN` in that environment.
   Do not remove protection for other contributors.
4. Configure the [npm trusted publisher](https://docs.npmjs.com/trusted-publishers) with owner `MaibornWolff`, repository `sandbox`, workflow `release.yml`, and environment `npm-production`.
   Use GitHub-hosted runners and npm 11.5.1 or newer.
5. Require npm two-factor authentication and disable token-based publishing.

Publishing uses OpenID Connect (OIDC), not an npm token.
Only the publish job receives OIDC permission.
GitHub write permission is separate and used after publication.
Public trusted publication adds provenance automatically.

## Publish

1. Pause merges and [Renovate](https://docs.renovatebot.com/) automerge so `main` stays unchanged.
2. Open **Actions > Release > Run workflow** on `main`.
3. Keep `dry_run` enabled, `candidate_run_id` empty, and `skip_ci_wait` disabled.
   Use `skip_ci_wait` only for an urgent release after manually verifying all required checks for the exact source commit.
4. Review the version, notes, job results, and `npm-release-candidate` artifact.
   Record the run ID.
   The immutable tarball must pass installation and publishing dry-run tests.
   Successful main-push CI, Compliance, and CodeQL for the exact source commit are also required, including shell, security, license, and both runtime E2E checks.
   Failed, missing, or skipped required jobs block publication.
5. Run the workflow again on the same commit with `dry_run` disabled and `candidate_run_id` set to the successful dry-run ID.
   This authorizes publication of the saved tarball without rebuilding it.
   The workflow repeats the dependency audit and checks that `main` has not changed.
6. Verify the npm version, matching `v<version>` tag, GitHub Release, and metadata commit on `main`.
   The commit must include the dated notes and a new empty `Unreleased` section.

To publish without a separate dry run, disable `dry_run` and leave `candidate_run_id` empty.
Review the candidate summary before publishing.
Candidate reuse requires a successful Release run for the current `main` commit and an available artifact.
Artifacts expire after 30 days.
A reuse run does not create a new artifact, so retain the original run ID.

Local `bun release prepare` changes the checkout only.
`bun release pack` saves the candidate and integrity, and `bun release validate` checks that candidate without rebuilding.
Use a disposable checkout.
Do not commit a locally prepared version before the workflow calculates its release.

## Recover

Publication and Git finalization are separate.
The saved source commit and tarball integrity identify what was published.
The workflow pushes the metadata commit and tag atomically without force.
It finalizes as soon as npm accepts the tarball, even if npm stages it for approval.

- Validation or source CI fails: fix or rerun checks for the exact source, then start a new dry run if the source changed.
- Security audit fails: fix critical non-denial-of-service findings or scanner errors.
  Denial-of-service advisories are ignored.
  Other severities are warnings.
- npm fails: rerun failed jobs from the same run.
  An existing version is accepted only if its integrity matches the candidate.
- npm stages approval: approve it on npm.
  If a rerun says `Cannot publish over previously staged version`, approve first, then retry failed jobs.
- Metadata or GitHub Release fails: fix permissions and rerun failed jobs from the same run.
  Finalization recognizes matching work already completed.
  Do not start a new release, rebuild the candidate, or move an existing tag.
- `main` advances before publication: start a new validated run from updated `main`.
- `main` advances after publication: download the saved artifact before expiry.
  In a disposable checkout of its `sourceCommit`, apply its `package.json` and `CHANGELOG.md`, then create the release commit and tag.
  Have an authorized maintainer integrate that history without overwriting newer `Unreleased` notes.
  Create the GitHub Release from saved `notes.md`.
  Do not republish.

npm publication cannot be reversed by rolling back Git.
Publish a new version for corrections.
Pushes using the default `GITHUB_TOKEN` do not trigger another Actions run.
If final metadata needs CI, use an approved credential that triggers [push workflows](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow).
