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
