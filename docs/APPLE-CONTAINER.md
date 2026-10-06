# Apple container runtime

## Recommended resource defaults

Set generous CPU and memory defaults for agent workloads. Builds, language servers, and parallel agents can need more resources than the Apple runtime defaults provide.

Sandbox does not set CPU or memory limits for Apple containers. New containers use the Apple runtime defaults.

1. Open `~/.config/container/config.toml`. Create the file if it does not exist.
2. Set the values in the existing `[container]` section, or add the section:

   ```toml
   [container]
   cpus = 12
   memory = "24g"
   ```

   This is an example for a host with enough CPU and memory. Use values that leave resources for macOS and other applications. Each container has its own limit. These values are not a shared resource pool, so account for the number of containers you run at the same time.

   Keep other settings in the file unchanged. You do not need to copy all runtime defaults into it.

3. Stop active Sandbox sessions before you restart the service. The restart stops running containers:

   ```bash
   container system stop
   container system start
   ```

4. Check the active defaults:

   ```bash
   container system property list
   ```

   The output should include:

   ```toml
   [container]
   cpus = 12
   memory = "24gb"
   ```

5. Recreate existing Sandbox containers. A restart of an existing container does not apply new resource defaults. Check new containers with `container list`.

The `[build]` section controls builder resources separately. The `[container]` settings do not change the builder limits.

See Apple's [system configuration tutorial](https://github.com/apple/container/blob/main/docs/tutorials/container-system-config-tutorial.md) and [system configuration reference](https://github.com/apple/container/blob/main/docs/container-system-config.md) for more options.
