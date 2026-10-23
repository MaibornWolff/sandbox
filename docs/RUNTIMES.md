# Container runtimes

Sandbox supports [Docker](https://docs.docker.com/engine/install/), [Podman](https://podman.io/docs/installation), and [Apple `container`](https://github.com/apple/container).

Install and start one supported runtime before running `sandbox doctor`.

- macOS or Linux: Docker, including Docker with [Colima](https://colima.run/) or [Rancher Desktop](https://rancherdesktop.io/), or Podman.
- Windows: Rancher Desktop with the [Windows Subsystem for Linux 2 (WSL2)](https://learn.microsoft.com/en-us/windows/wsl/install) backend, or Podman.
- Apple `container`: Apple silicon, macOS 26 or newer, and `container` 1.4.1 or newer.
  Start it with `container system start`.

Sandbox selects the first installed runtime in this order: Docker, Podman, Apple `container`.
It checks executable availability, not service health.
Select a runtime explicitly if an earlier installed runtime is stopped.
To select one explicitly, add this to your user configuration:

```toml
runtime = "podman"
```

Allowed values are `"docker"`, `"podman"`, and `"apple-container"`.
Docker-compatible tools still use Dockerfile syntax when the selected runtime is not Docker.

Run `sandbox doctor` to check runtime availability and configuration.
See [Apple runtime settings](APPLE-CONTAINER.md) for DNS and resource defaults.

## Windows paths

Sandbox converts Windows paths such as `C:\\Users\\...` to runtime-compatible paths.
Use paths that your selected runtime can share.
See [mounts](MOUNTS.md) if the agent needs files outside the project.
