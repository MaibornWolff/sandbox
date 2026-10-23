# Apple runtime settings

Use [Apple `container`](https://github.com/apple/container) on Apple silicon with macOS 26 or newer and runtime version 1.4.1 or newer.
Select it in your user configuration:

```toml
runtime = "apple-container"
```

## DNS

The default keeps the runtime resolver unchanged.
If its DNS proxy does not answer, select a host resolver:

```toml
[runtimes.apple-container]
dns = "host"
```

- `"default"`: use the runtime default.
- `"host"`: use a reachable server from the primary macOS DNS configuration.
  Local-only servers and domain-specific VPN resolvers are not selected.
  Sandbox does not substitute public DNS.
- `"host-ipv6"`: use the macOS bridge IPv6 resolver.
  This requires a working host IPv6 DNS proxy.

In host modes, Sandbox checks the shared builder resolver before image builds.
If a running builder has different settings, wait for its builds to finish, run `container builder stop`, and retry.
For an abandoned DNS lock, confirm that no Sandbox builds are running before removing the reported lock file.

Host services use `host.container.internal`, with `host.docker.internal` as a compatibility alias.
These are exact names, not wildcard domains.
The service must listen on an address reachable from the container gateway, not only on localhost.
The network allowlist still applies.

## CPU and memory

Sandbox does not set Apple container CPU or memory limits.
Use the runtime's `~/.config/container/config.toml` to change defaults.
For a host with enough resources, an example is:

```toml
[container]
cpus = 12
memory = "24g"
```

Each container gets its own limit.
Leave enough resources for macOS and other containers.
Builder resources use the separate `[build]` section.

After saving:

1. End active sessions.
   Restarting the service stops running containers.
2. Run `container system stop`, then `container system start`.
3. Check `container system property list`.
4. Recreate existing Sandbox containers.
   Restarting an old container does not apply new defaults.
5. Verify new containers with `container list`.

See Apple's [configuration tutorial](https://github.com/apple/container/blob/main/docs/tutorials/container-system-config-tutorial.md) and [configuration reference](https://github.com/apple/container/blob/main/docs/container-system-config.md).
