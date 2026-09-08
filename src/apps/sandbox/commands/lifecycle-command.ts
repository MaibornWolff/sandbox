import type { Command } from "commander";
import {
  displayEnvironmentCheck,
  doctorCommand,
  setupX11Command,
} from "#modules/diagnostics/index.js";
import {
  cleanCommand,
  statusCommand,
  stopCommand,
} from "#modules/sandbox-containers/index.js";
import { buildCommand, upgradeCommand } from "#modules/sandbox-images/index.js";
import { migrateCommand } from "#modules/sandbox-resources/index.js";
import { updateCommand } from "#modules/self-update/index.js";
import { initCommand } from "#modules/workspace-setup/index.js";
import { requireHost } from "../host-environment.js";
import { mergeCliOptions } from "./cli-options.js";

export function registerLifecycleCommands(program: Command): void {
  program
    .command("build")
    .description("Build/rebuild all layers")
    .option("--no-cache", "Rebuild without cache")
    .option("--user", "Build user and project layers (skip base)")
    .option("--project", "Build only project layer (skip base and user)")
    .action(async (options, cmd) => {
      requireHost("build");
      const globalOpts = cmd.parent.opts();
      await buildCommand(mergeCliOptions(globalOpts, options));
    });

  program
    .command("upgrade")
    .description("Rebuild all layers with --no-cache (fresh packages)")
    .option("--user", "Rebuild user and project layers (skip base)")
    .option("--project", "Rebuild only project layer (skip base and user)")
    .action(async (options, cmd) => {
      requireHost("upgrade");
      const globalOpts = cmd.parent.opts();
      await upgradeCommand(mergeCliOptions(globalOpts, options));
    });

  program
    .command("migrate")
    .description(
      "Migrate legacy sandbox image, container, volume, and Dockerfile names",
    )
    .action(async (_options, cmd) => {
      requireHost("migrate");
      const globalOpts = cmd.parent.opts();
      await migrateCommand(globalOpts);
    });

  program
    .command("status")
    .description("Show sandbox container status")
    .action(async (_options, cmd) => {
      requireHost("status");
      const globalOpts = cmd.parent.opts();
      await statusCommand(globalOpts);
    });

  program
    .command("stop")
    .description("Stop and remove sandbox containers")
    .option(
      "-a, --all",
      "Stop all sandbox containers (not just current project)",
    )
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (options, cmd) => {
      requireHost("stop");
      const globalOpts = cmd.parent.opts();
      await stopCommand({ ...globalOpts, ...options });
    });

  program
    .command("init")
    .description("Initialize sandbox configuration")
    .option(
      "-p, --project",
      "Initialize project-level config (instead of user-level)",
    )
    .option(
      "--tools <ids>",
      "Non-interactive tool selection (comma-separated IDs, e.g. node,mise-env)",
      (value: string) => value.split(",").map((s) => s.trim()),
    )
    .action(async (options) => {
      requireHost("init");
      const result = await initCommand(options);
      if (result === "user") await displayEnvironmentCheck();
    });

  program
    .command("clean")
    .description("Remove containers, volumes, and dangling images")
    .option("-a, --all", "Remove all containers (including running)")
    .option("-d, --data", "Also remove persistent data")
    .option("-f, --force", "Skip confirmation prompts")
    .action(async (options, cmd) => {
      requireHost("clean");
      const globalOpts = cmd.parent.opts();
      const merged = { ...globalOpts, ...options };

      await cleanCommand(merged);
    });

  program
    .command("setup-x11")
    .description("Setup and validate X11 clipboard support")
    .action(async () => {
      requireHost("setup-x11");
      await setupX11Command();
    });

  program
    .command("update")
    .description("Update sandbox CLI to latest version")
    .action(async () => {
      requireHost("update");
      await updateCommand();
    });

  program
    .command("doctor")
    .description("Check sandbox configuration and environment")
    .action(async () => {
      requireHost("doctor");
      await doctorCommand();
    });
}
