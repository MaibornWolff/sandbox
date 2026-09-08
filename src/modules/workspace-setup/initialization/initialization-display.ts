import chalk from "chalk";
import { writeStandardOutput } from "#platform/terminal/index.js";
import type { DetectedConfig } from "../agent-config-copying.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";

/**
 * Display welcome message with intro to sandbox
 */
export function displayWelcome(): void {
  writeStandardOutput();
  writeStandardOutput(chalk.bold.cyan("  Welcome to Sandbox"));
  writeStandardOutput();
  writeStandardOutput(
    chalk.dim("  Sandbox runs AI coding agents in isolated Docker containers,"),
  );
  writeStandardOutput(
    chalk.dim("  letting them operate with full permissions safely. Your host"),
  );
  writeStandardOutput(
    chalk.dim("  system stays protected while agents can edit files, run"),
  );
  writeStandardOutput(
    chalk.dim(
      "  commands, and access the network through controlled channels.",
    ),
  );
  writeStandardOutput();
}

/**
 * Display feature overview explaining key sandbox concepts
 */
export function displayFeatureOverview(): void {
  writeStandardOutput(chalk.dim("─".repeat(67)));
  writeStandardOutput();
  writeStandardOutput(chalk.bold("How Sandbox Works"));
  writeStandardOutput();

  const features = [
    {
      name: "Isolation",
      desc: [
        "Your project runs inside a Docker container. The agent can",
        "freely modify files and run commands without affecting your",
        "host system.",
      ],
    },
    {
      name: "Persistence",
      desc: [
        "Containers are temporary, but you can preserve data between",
        "sessions. Configure which paths to keep in config.toml under",
        "'persist_paths' (e.g., shell history, agent credentials).",
      ],
    },
    {
      name: "Settings",
      desc: [
        "Share configuration files (e.g., .claude/settings.json,",
        ".zshrc.local, .profile.local) from ~/.config/sandbox/settings/",
        "into every sandbox. New files created inside are synced back on exit.",
      ],
    },
    {
      name: "Network",
      desc: [
        "By default, outbound connections are blocked. Allow the",
        "domains you need (APIs, package registries) in config.toml",
        "under 'allow_network'. Use 'full_network = true' to disable",
        "the firewall entirely.",
      ],
    },
    {
      name: "Customization",
      desc: [
        "Install additional tools by editing the Dockerfile at",
        "~/.config/sandbox/docker/Dockerfile, then run 'sandbox build'.",
        "For project-specific settings, run 'sandbox init -p' in your",
        "project directory.",
      ],
    },
  ];

  for (const feature of features) {
    writeStandardOutput(
      `  ${chalk.bold(feature.name.padEnd(13))} ${chalk.dim(feature.desc[0])}`,
    );
    for (let i = 1; i < feature.desc.length; i++) {
      writeStandardOutput(`  ${"".padEnd(13)} ${chalk.dim(feature.desc[i])}`);
    }
    writeStandardOutput();
  }
}

/**
 * Display separator line
 */
export function displaySeparator(): void {
  writeStandardOutput(chalk.dim("─".repeat(67)));
  writeStandardOutput();
}

/**
 * Get the selected agent tool IDs in registry order
 */
function getSelectedAgentIds(selectedToolIds: string[]): string[] {
  return TOOL_REGISTRY.filter(
    (tool) =>
      tool.category.section === "ai-agents" &&
      selectedToolIds.includes(tool.id),
  ).map((t) => t.id);
}

/**
 * Display what the agent can access inside the sandbox
 */
export function displayAccessSummary(): void {
  writeStandardOutput(chalk.bold("What your agent can access:"));
  writeStandardOutput(
    `  ${chalk.green("✓")} Your project directory           ${chalk.dim("(read-write)")}`,
  );
  writeStandardOutput(
    `  ${chalk.green("✓")} Allowed network domains          ${chalk.dim("(see config.toml)")}`,
  );
  writeStandardOutput(`  ${chalk.red("✗")} Other files on your system`);
  writeStandardOutput(`  ${chalk.red("✗")} Other network destinations`);
}

/**
 * Display "Ready to go" with the concrete run command
 */
export function displayReadyToGo(selectedToolIds: string[]): void {
  const agents = getSelectedAgentIds(selectedToolIds);
  const primaryCmd =
    agents.length > 0 ? `sandbox run ${agents[0]}` : "sandbox run claude";
  const otherAgents = agents.slice(1);

  writeStandardOutput(chalk.bold("\nReady to go!"));
  writeStandardOutput(`  ${chalk.dim("cd <your-project>")}`);
  writeStandardOutput(`  ${chalk.cyan(primaryCmd)}`);
  if (otherAgents.length > 0) {
    const others = otherAgents.map((id) => `sandbox run ${id}`).join(", ");
    writeStandardOutput(chalk.dim(`  Also available: ${others}`));
  }

  writeStandardOutput(chalk.bold("\nUseful commands:"));
  writeStandardOutput(
    `  ${chalk.dim("sandbox")}                Interactive shell in sandbox`,
  );
  writeStandardOutput(
    `  ${chalk.bold.cyan("sandbox assist")}         Start an agent for sandbox help`,
  );
  writeStandardOutput(
    `  ${chalk.dim("sandbox doctor")}         Verify your setup`,
  );
  writeStandardOutput(
    `  ${chalk.dim("sandbox config")}         Show active configuration`,
  );
  writeStandardOutput(
    `  ${chalk.dim("sandbox network logs")}   Show blocked network requests`,
  );
  writeStandardOutput(
    `  ${chalk.dim("sandbox config update")}  Update config from latest templates`,
  );
  writeStandardOutput(
    `  ${chalk.dim("sandbox upgrade")}        Rebuild with latest tools`,
  );
  writeStandardOutput(
    `  ${chalk.dim("sandbox -N run claude")}  Run with full network access`,
  );
  writeStandardOutput(`  ${chalk.dim("sandbox --help")}         All options`);
}

/**
 * Display configuration file locations
 */
export function displayConfigLocations(
  configPath: string,
  dockerfilePath: string,
  settingsDir: string,
): void {
  writeStandardOutput(chalk.bold("\nConfiguration:"));
  writeStandardOutput(`  ${chalk.cyan(configPath)}`);
  writeStandardOutput(
    `  ${chalk.dim("Main config (API keys, network, mounts)")}`,
  );
  writeStandardOutput(`  ${chalk.cyan(dockerfilePath)}`);
  writeStandardOutput(`  ${chalk.dim("Add tools, then run: sandbox build")}`);
  writeStandardOutput(`  ${chalk.cyan(settingsDir)}`);
  writeStandardOutput(
    `  ${chalk.dim("Shared into every sandbox: .claude/settings.json, .zshrc.local, .profile.local, ...")}`,
  );
}

export function displayInitAssistHint(): void {
  writeStandardOutput();
  writeStandardOutput(
    `Run ${chalk.bold.cyan("sandbox assist")} to start an agent for customization, debugging, or questions.`,
  );
}

/**
 * Display bypass settings explanation
 * Shows what settings will be added for each agent
 */
export function displayBypassExplanation(configs: DetectedConfig[]): void {
  writeStandardOutput(
    chalk.dim(
      "  AI agents normally ask for confirmation before running commands or editing files.",
    ),
  );
  writeStandardOutput(
    chalk.dim(
      "  Inside the sandbox, this is unnecessary - the container is already isolated from your system.",
    ),
  );
  writeStandardOutput(
    chalk.dim(
      "  Enabling this lets agents run freely without permission prompts.",
    ),
  );
  writeStandardOutput();

  for (const config of configs) {
    // Check if it's Claude or Codex based on name
    if (config.name === "Claude Code") {
      writeStandardOutput(
        `  ${config.name}:  ${chalk.dim('permissions.defaultMode = "bypassPermissions"')}`,
      );
    } else if (config.name === "Codex") {
      writeStandardOutput(
        `  ${config.name}:        ${chalk.dim('approval_policy = "never", sandbox_mode = "danger-full-access"')}`,
      );
    }
  }
  writeStandardOutput();
}
