# Agent authentication

See your agent's login guide: [Claude Code](https://code.claude.com/docs/en/authentication), [Codex](https://developers.openai.com/codex/auth/), [OpenCode](https://opencode.ai/docs/providers/), [Pi](https://github.com/badlogic/pi-mono), or [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli).

Choose the login method your agent supports.
Credentials available inside the container can be read or used by agent processes.

## API keys

Set the key in the host terminal where you will start Sandbox.
For [Bash](https://www.gnu.org/software/bash/manual/) or [zsh](https://zsh.sourceforge.io/Doc/):

```bash
export ANTHROPIC_API_KEY='your-key'
```

For [PowerShell](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables):

```powershell
$env:ANTHROPIC_API_KEY = 'your-key'
```

These examples affect the current terminal and its child processes.
For new terminals, use your shell's startup configuration or a secret manager.
Avoid exposing real keys in shell history or committed files.

In `{config}/config.toml`, find the existing `env` list and uncomment or add the key's name.
Keep the other entries:

```toml
# Inside the existing env = [ ... ] list:
"ANTHROPIC_API_KEY",
```

See [configuration paths](CONFIGURATION.md#paths) for the file location.
Do not add a second `env` key or store the secret value in TOML.

Use `OPENAI_API_KEY` or the provider's required name for other agents.
No API keys are forwarded by the generated configuration until you enable them.

Start a new session after changing the key or `env`.
Do not commit secret values in project configuration.

## Agent login inside the container

Run the agent's supported login flow inside Sandbox.
The generated `persist_paths` keep common agent state and selected credential files.
Some credentials are global across projects.
Review [persistence](PERSISTENCE.md) before changing their scope.

Browser flows that redirect to localhost may need a different login method inside a container.

## Claude Code

Select Claude Code during `sandbox init`, then start it:

```bash
sandbox run claude
```

Follow its login prompts to use a supported subscription, or use the API-key setup above.
The generated persistence keeps its login state across containers and shares selected credential files across projects.
See [Claude authentication](https://code.claude.com/docs/en/authentication) for account requirements and supported login methods.

## Codex

The generated configuration mounts the host login read-only:

```toml
mounts = ["~/.codex/auth.json:ro"]
```

Log in to Codex on the host, then run `sandbox run codex`.
Manage the login on the host.
This shares the host account session rather than creating a separate container login.

For a separate container login:

1. Remove the host auth mount from the configuration that defines it.
2. Enable device authentication in the ChatGPT web UI if required.
3. Run `sandbox run codex login --device-auth`.
4. Add persistent storage for the login:

   ```toml
   persist_paths = [
     { path = "~/.codex/auth.json", default = "{}", global = true },
   ]
   ```

Avoid the normal localhost browser redirect flow inside the container.

## GitHub and GitLab CLI

Sandbox does not automatically share [GitHub CLI (`gh`)](https://cli.github.com/manual/) or [GitLab CLI (`glab`)](https://docs.gitlab.com/cli/) credentials.
To expose an existing host login, add explicit mounts to the existing `mounts` list in your user `config.toml`:

```toml
mounts = ["~/.config/gh:ro", "~/.config/glab-cli:ro"]
```

Use the actual host path if your tool stores credentials elsewhere.
Read-only mounts may prevent token refresh or login writes.
For a separate container login, authenticate inside Sandbox and persist the tool's configuration directory.

A `settings` entry reads from `{config}/settings/`.
It does not mount the corresponding directory from your host home.
See [shared settings](SETTINGS-SYNC.md).
