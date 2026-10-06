import type { Command } from "commander";
import type { AppGlobalOptions } from "../options.js";

export function normalizeCliOptions(
  options: AppGlobalOptions,
): AppGlobalOptions {
  const { build, ...rest } = options;

  if (build === false) {
    return { ...rest, noBuild: true };
  }

  return rest;
}

export function mergeCliOptions(
  globalOptions: AppGlobalOptions,
  commandOptions: AppGlobalOptions,
): AppGlobalOptions {
  return {
    ...normalizeCliOptions(globalOptions),
    ...normalizeCliOptions(commandOptions),
  };
}

function addNoBuildOption<T extends Command>(command: T): T {
  return command.option(
    "--no-build",
    "Skip image builds and use the existing final image",
  );
}

export function validateRunOptions(
  options: AppGlobalOptions,
  cmd: Command,
): void {
  if (options.silent && options.verbose) {
    cmd.error("error: --silent cannot be used with --verbose");
  }
}

export function configureGlobalOptions(program: Command): void {
  addNoBuildOption(program)
    .option(
      "-m, --mount <mount>",
      "Add mount (repeatable)\n" +
        "  /path          → mount to same path (readonly)\n" +
        "  /path:rw       → mount to same path (read-write)\n" +
        "  /src:/dst      → mount with custom destination (readonly)\n" +
        "  /src:/dst:rw   → mount with read-write access",
      (value: string, previous: string[]) => {
        return previous ? [...previous, value] : [value];
      },
      [] as string[],
    )
    .option(
      "-e, --env <env>",
      "Set session env var (repeatable)\n" +
        "  MY_VAR         → pass through from host\n" +
        "  FOO=bar        → set explicit value\n" +
        "  Reserved: SANDBOX, SANDBOX_*, CLAUDE_CODE_SSE_PORT, DISPLAY, X11_AVAILABLE",
      (value: string, previous: string[]) => {
        return previous ? [...previous, value] : [value];
      },
      [] as string[],
    )
    .option(
      "-p, --port <port>",
      "Expose port (repeatable)\n" +
        "  8080           → same port on host and container\n" +
        "  8080:3000      → host:container\n" +
        "  127.0.0.1:8080:3000 → bind to specific interface",
      (value: string, previous: string[]) => {
        return previous ? [...previous, value] : [value];
      },
      [] as string[],
    )
    .option(
      "-n, --allow-network <host>",
      "Allow host through firewall (repeatable)\n" +
        "  github.com         → allow on ports 80, 443\n" +
        "  github.com:22      → allow on specific port\n" +
        "  github.com:{22,443} → allow on multiple ports",
      (value: string, previous: string[]) => {
        return previous ? [...previous, value] : [value];
      },
      [] as string[],
    )
    .option(
      "-N, --full-network",
      "Disable network firewall (allow all outbound)",
    )
    .option("-P, --no-proxy", "Disable proxy (requires --full-network)")
    .option("-r, --readonly", "Mount project read-only")
    .option(
      "-c, --clipboard <mode>",
      "Clipboard mode: auto (default), x11, or disabled",
    )
    .option("-v, --verbose", "Show detailed timing information")
    .option("-u, --no-container-reuse", "Force fresh container (disable reuse)")
    .option("-t, --trust", "Trust project config without prompting");

  program.addHelpText(
    "after",
    `
Examples:
  # Start interactive shell
  $ sandbox                                    # Open shell in sandbox
  $ sandbox --readonly                         # Open shell, project readonly
  $ sandbox --no-build                         # Reuse existing image without rebuilding

  # Run AI coding agents
  $ sandbox run claude                         # Run Claude Code
  $ sandbox run codex                          # Run Codex
  $ sandbox --env OPENAI_API_KEY run opencode  # Run Opencode with API key

  # Work with data files
  $ sandbox --mount /tmp:rw                    # Mount /tmp with read-write
  $ sandbox --mount ~/data:/data:rw            # Mount data directory for editing
  $ sandbox -m ./output:/output:rw run python analyze.py

  # Development workflows
  $ sandbox --mount ~/code:/work:rw --env GITHUB_TOKEN
  $ sandbox -e DEBUG=1 run node server.js
`,
  );
}
