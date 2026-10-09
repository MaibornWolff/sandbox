# Changelog

## [Unreleased]

### Added

- Release Sandbox as an open-source CLI for container-based coding-agent sessions.
- Add a manually started npm release workflow with a dry-run mode and maintained release notes.

### Changed

- Calculate release versions from commit history instead of manual version inputs. Use `bun release prepare` without version arguments for local preparation.
- Reuse source CI and saved dry-run packages for releases. Approve candidates while validation runs. Existing release setups must move required reviewers to the new `npm-release-approval` environment. Run `bun release validate` after local `bun release pack` to test the saved package.
