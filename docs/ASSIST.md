# AI-assisted help

Run this on the host from your project directory:

```bash
sandbox assist
```

Sandbox detects an installed supported agent and gives it the docs, source code, and relevant configuration paths.
You can ask it to explain an option, change your setup, or diagnose a problem.

To choose an agent or ask a direct question:

```bash
sandbox assist --agent claude
sandbox assist "How do I persist node_modules?"
```

Supported integrations include [Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://developers.openai.com/codex/cli/), [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli), [Pi](https://github.com/badlogic/pi-mono), and [OpenCode](https://opencode.ai/docs/).
Some integrations need a question for automatic launch.
If an integration cannot launch interactively, Sandbox writes a context file and gives you the next steps.

The assistant runs with the permissions of the environment where you start it.
On the host, it is not sandboxed by this command.
Review proposed configuration changes, especially access rules.

Inside a container, it can explain the setup, but host configuration changes must be made on the host.
