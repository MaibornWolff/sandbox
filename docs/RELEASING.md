# Releasing Sandbox

Releases start manually through `.github/workflows/release.yml`. The workflow
calculates the next version from commit history. Maintainers review the written
release notes. No version input is required.

## Version policy

- Read commits after the `v<current-version>` tag, where `current-version`
  comes from `package.json`. The checkout must include full history and tags.
- Before the first tagged release, read the complete commit history.
- Conventional Commit subjects with `feat:` or `feat(scope):` select **minor**.
  A `!` before the colon or a `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer
  also selects **minor**, for example `0.72.0`.
- Other commits select **patch**, for example `0.71.1`.
- Use the highest increment found across all unreleased commits.
- Stop if no commits follow the current version tag, or if that tag is missing
  when earlier release tags exist.
- Stay in `0.x` until maintainers explicitly adopt a stable `1.0.0` policy.

## Maintain the changelog

Write user-visible changes under `## [Unreleased]` in `CHANGELOG.md`. Agents can
write and revise these notes in normal pull requests. Maintainers review them.
Use only relevant sections, such as `Added`, `Changed`, `Fixed`, `Removed`,
`Security`, and `Breaking Changes`.

Write for product users only. Include user-facing capabilities, behavior,
fixes, security changes, and required migration steps. Add short command or
configuration examples when they help users apply or understand a change.
Exclude CI, tests, release processes, development workflows, and internal
implementation. Combine related changes. Do not generate the changelog from
commit messages. Correct published notes only for factual errors.

For the first public release, write a short overview of the existing product
capabilities. Present it as the initial open-source release. Do not describe the
internal work that prepared the repository for publication.

Before a release, merge the reviewed notes into `main`. Leave the package version
unchanged. The release workflow prepares the version and dated notes in its
checkout. After npm publication, it commits those files back to `main` and adds
an empty `Unreleased` section for the next changes.

## One-time configuration

1. Confirm that the npm organization owns the `@maibornwolff` scope and that the
   release maintainer can publish `@maibornwolff/sandbox` publicly.
2. Create the GitHub environment `npm-production` and restrict it to `main`.
   Keep release secrets in this environment. The manual workflow dispatch
   authorizes publication, so the environment does not require a second human
   approval.
3. Permit the release identity to push the release commit to `main` and create
   public `v0.*` tags. Do not remove branch protection for all contributors.
   The default `GITHUB_TOKEN` works only if repository rules permit its writes.
   If necessary, set the environment secret `RELEASE_GITHUB_TOKEN` to a narrowly
   scoped GitHub credential with contents write permission and an authorized
   ruleset bypass identity. The pipeline does not configure a bypass itself.
4. Configure the npm trusted publisher of `@maibornwolff/sandbox` with owner
   `MaibornWolff`, repository `sandbox`, workflow filename `release.yml`, and
   environment `npm-production`. Use GitHub-hosted runners and npm 11.5.1 or
   newer.
5. Enable npm's requirement for 2FA and disallow token-based publishing.

The publish job authenticates only through trusted publishing. It does not use
an npm token. Trusted publishing uses OpenID Connect (OIDC) instead of a
permanent npm token. For a public package built from a public repository, it
adds provenance attestations automatically. Read the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers)
when configuring the publisher.

The workflow grants npm OIDC permission only to the publish job. GitHub write
permission is separate and is used only after npm publication.

## Run a release

1. Keep `main` unchanged during publication. Ask contributors to pause merges
   and pause Renovate automerge for the release window.
2. Open **Actions > Release > Run workflow** and select `main`.
3. Leave **dry_run** enabled for the first run. Leave **candidate_run_id** empty
   and **skip_ci_wait** disabled. Enable **skip_ci_wait** only for an urgent
   release after you manually confirm that all required checks passed for the
   exact `main` commit. This option bypasses the automated CI safety gate.
4. Check the calculated version, job results, release notes, and
   `npm-release-candidate` artifact. Record the workflow run ID.
   The workflow packs an immutable candidate, then tests installation and
   `npm publish --dry-run` from that tarball without rebuilding it.
   In parallel, **Wait for CI** requires successful main-push CI, Compliance,
   and CodeQL runs on the exact source commit. These checks include shell tests,
   dependency security, licenses, and Docker and Podman end-to-end tests.
   Failed, missing, or skipped required jobs block publication.
5. Run the workflow again from the same commit with **dry_run** disabled.
   Set **candidate_run_id** to the successful dry-run ID. This manual action
   authorizes publication. The workflow reuses the saved tarball and validation
   instead of rebuilding or repeating tests. Candidate reuse requires a
   successful Release run on the current `main` commit with an available
   `npm-release-candidate` artifact. The workflow repeats the dependency
   security audit immediately before publishing and verifies that `main` has
   not changed.
6. Confirm the npm version, `v<version>` tag, GitHub Release, and commit on `main`.
   The commit must contain the released package version, dated changelog notes,
   and an empty `Unreleased` section.

For a release without a separate dry run, disable **dry_run** and leave
**candidate_run_id** empty. Review the candidate summary before publishing.
Candidate artifacts expire after 30 days. A reused run does not create another
copy of the artifact: keep the ID of the original run that packed it.

Dry runs have no publishing credentials or GitHub write permissions. They do not
publish to npm, push commits or tags, or create GitHub Releases. A local
`bun release prepare` calculates the version and changes the checkout only.
`bun release pack` builds and saves the candidate with its integrity.
`bun release validate` tests the saved candidate without rebuilding it.
Use a disposable checkout for local release tests. Do not commit the prepared
version before running the workflow, because the workflow calculates the next
version from `main`.

## Publication and recovery

The workflow records the source commit and tarball integrity. It publishes the
same tarball that passed installation tests. The finalize job starts directly
after npm accepts the tarball. It commits the metadata, creates the tag, and
creates the GitHub Release. It does not wait until npm shows the version,
because npm can stage a version for approval. The main commit and tag
are pushed atomically without force. GitHub Release notes come from the prepared
changelog, not from generated commit summaries.

- **Validation fails:** correct the source or notes and start a new dry run.
- **Source CI fails or is missing:** correct or rerun the main-push checks for
  the exact source commit. Manual branch checks do not replace main-push CI.
- **Security audit fails:** correct critical non-denial-of-service dependency
  vulnerabilities before releasing. Scanner and registry errors also block
  publication. Denial-of-service advisories are ignored. Other high, moderate,
  and low findings are non-blocking warnings.
- **npm fails:** rerun the failed jobs from the same workflow run. An existing
  version is accepted only when its integrity matches the saved candidate.
  Authentication and registry errors stop the release.
- **npm stages the version for approval:** approve it on npm. The tag, release
  commit, and GitHub Release already exist. If a rerun reports
  `Cannot publish over previously staged version`, approve the staged version
  first and then rerun the failed jobs.
- **Commit or GitHub Release creation fails:** rerun the failed jobs from the
  same run after correcting permissions. Do not start a new release or rebuild
  the published version. Finalization recognizes an already completed matching
  commit and tag.
- **main advances before publication:** the workflow stops before publishing.
  Start a new validated run from the updated `main`.
- **main advances after publication:** the workflow stops without overwriting
  concurrent changes. Download the saved candidate. In a disposable checkout of
  its `sourceCommit`, apply its `package.json` and `CHANGELOG.md`, then create a
  release commit and tag. Have an authorized maintainer merge or push this
  history into `main` while preserving new `Unreleased` notes. Create the GitHub
  Release from the saved `notes.md`. Do not republish or move an existing tag.

Recover from the saved workflow artifact before it expires. npm publication is
not reversible by rolling back Git. Publish a new version for corrections.

Pushes made with the default `GITHUB_TOKEN` do not trigger another Actions run.
The candidate has already passed the release gates. If the repository requires
CI on the final metadata commit, use an approved release credential that triggers
push workflows. Read the [GitHub workflow trigger documentation](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow).
