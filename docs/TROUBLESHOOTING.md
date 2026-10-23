# Troubleshooting

Start on the host, from the affected project:

```bash
sandbox doctor
sandbox --verbose run <command>
```

Use your failing command in place of `<command>`.
For agent help, run `sandbox assist`.
That assistant runs on the host, so review its proposed changes.

## The agent cannot see a file

The complete detected project is mounted, not the complete host filesystem.
Check the project root and add an explicit [mount](MOUNTS.md) for paths outside it.

For permission errors after a Dockerfile change, run `sandbox build`.

## Build fails with EACCES

Stale [BuildKit](https://docs.docker.com/build/buildkit/) cache permissions can cause build failures, especially on Windows.
For Docker, inspect the builder cache with `docker buildx du`.
If the failure is caused by stale cache permissions, run `docker builder prune`, review its prompt, then retry `sandbox build`.
This deletes build cache beyond Sandbox and can slow other projects' builds.

## The agent or a tool is missing

Confirm that you selected it during setup and that the expected Dockerfile installs it.
Run `sandbox upgrade --user` for personal tools, or `sandbox upgrade --project` for project tools.
Then verify it in a new session.

## Login fails

See [agent authentication](AUTHENTICATION.md).
For Codex, use the host auth mount or device login instead of a container localhost browser redirect.
For `gh` and `glab`, explicitly share credentials or log in and persist them inside the container.

## A request is blocked

Follow [network diagnostics](NETWORK-FIREWALL.md#find-a-blocked-request).
Check download and redirect domains.
For [Java](https://docs.oracle.com/en/java/) or [Gradle](https://docs.gradle.org/current/userguide/userguide.html) failures, inspect the logs even though Sandbox sets Java proxy options.
A protocol that cannot use proxy tunneling can fail even with an allowed domain.

## Apple DNS or resource failures

See [Apple runtime settings](APPLE-CONTAINER.md).
Do not replace corporate or VPN resolvers with a public DNS service without checking the consequences.

## Settings link errors

A selected mount-mode source resolves outside `{config}/settings/`.
Follow [the migration steps](SETTINGS-SYNC.md#symbolic-links-and-overlapping-paths).
Unexpected link errors can indicate changes from another container sharing the directory.

## Project configuration is untrusted in CI

Review the repository's `.sandbox/` files first.
For trusted automation, pass `--trust` or set `SANDBOX_TRUST_ALL=1`.
See [project trust](PROJECTS.md#trust).

## Docker buildx is missing with Colima

On a [Homebrew](https://docs.brew.sh/)-based macOS setup with [Colima](https://colima.run/), install [Docker buildx](https://docs.docker.com/build/concepts/overview/#buildx):

```bash
brew install docker-buildx
mkdir -p ~/.docker/cli-plugins
ln -sfn "$(brew --prefix docker-buildx)/bin/docker-buildx" ~/.docker/cli-plugins/docker-buildx
docker buildx version
```

## Build downloads hit GitHub API limits

Some tool installers use the [GitHub API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
Set `GITHUB_TOKEN` in the host environment if authentication is required, then retry.
Sandbox forwards it as a build secret.
Use a token with only the required permissions.
Never put its value in a Dockerfile or committed configuration.

## Report an issue

For an unresolved issue, include your Sandbox version, runtime, host platform, failing command, and relevant diagnostic output.
Remove secrets before sharing logs.
