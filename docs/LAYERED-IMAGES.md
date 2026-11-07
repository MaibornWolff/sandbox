# Custom tools and images

Install tools in the scope where you need them:

- Base image: Sandbox-managed operating system and common tools.
- User image: your agents and tools for all projects.
- Project image: tools required by one repository.

A project inherits the user image when it exists.
It cannot opt out of that image or select an unrelated base.

## Select tools

```bash
sandbox init
```

Select personal agents and tools in the prompts.
For repository-specific tools, run this from the project:

```bash
sandbox init --project
```

For non-interactive project tool selection, use `sandbox init --project --tools <ids>`.
For example, `sandbox init --project --tools node,mise-env`.
Run `sandbox init --help` for available setup options.

## JavaScript package managers

The `node` tool installs Node.js LTS and its bundled npm through mise.
The `pnpm` tool installs pnpm through mise and also selects Node.js.
Neither tool enables Corepack or installs Yarn.
To install Yarn, add `RUN mise use -g yarn@<version>` to your Dockerfile as `USER sandbox`, before its final `USER root` instruction.
Replace `<version>` with the required Yarn version.

For project-specific versions, add or merge a `[tools]` section in your repository's `mise.toml`:

```toml
[tools]
node = "26"
pnpm = "10.15.0"
```

Select `mise-env` to install these tools during the project image build:

```bash
sandbox init --project --tools node,pnpm,mise-env
```

Include any other tools you want to keep in the selection.
Use exact versions when you need reproducible tool versions.
Sandbox does not configure automatic package-manager selection from `package.json`'s `packageManager` field.
Declare the required versions in mise configuration instead of relying on Corepack.

### Migrate existing Dockerfiles

Update `{config}/docker/Dockerfile` and `.sandbox/docker/Dockerfile` where present:

1. Remove `RUN corepack enable`.
2. Replace `RUN corepack install -g pnpm@latest` with `RUN mise use -g pnpm@latest`.
   If the old command selected a specific pnpm version, keep that version.
3. Install Yarn explicitly if your projects need it.
4. Preserve the parent image, other setup, and final `USER root` instruction.
5. Run `sandbox build --user` to rebuild user and project images.

For agent help with migration, run [`sandbox assist`](ASSIST.md) on the host.
Verify the result in a new session with `sandbox run node --version` and `sandbox run pnpm --version`.

## Add custom packages

Edit the generated [Dockerfile](https://docs.docker.com/reference/dockerfile/) and preserve its parent image and existing setup:

- User: `{config}/docker/Dockerfile`.
- Project: `.sandbox/docker/Dockerfile`.

For a [Debian](https://www.debian.org/doc/) system package, add root and user steps before the generated Dockerfile's final `USER root` startup instruction.
Keep that final instruction unchanged:

```dockerfile
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
USER sandbox
```

Keep package actions together.
Do not put credentials in image layers.
Sandbox runtime commands are available during container sessions, not during Dockerfile `RUN` steps.

## Build and upgrade

```bash
sandbox build
sandbox build --user
sandbox build --project
```

Normal builds reuse cached layers.
A changed layer also changes its child layers.
Targeted builds check parent layers and rebuild them if required.

To refresh installed packages and agents without cached package steps:

```bash
sandbox upgrade
sandbox upgrade --user
sandbox upgrade --project
```

`--user` includes the project layer.
`--project` targets the project layer.
CLI runtime-only updates do not require rebuilding tool images.

Verify the tool in a new session, for example `sandbox run rg --version`.
See [updates](UPDATES.md) for CLI updates and cleanup.
