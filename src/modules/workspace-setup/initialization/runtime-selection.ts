import chalk from "chalk";
import type { RuntimeId } from "#modules/configuration/index.js";
import {
  getRuntimeProvider,
  type RuntimeProbe,
} from "#platform/container-runtime/index.js";
import { selectOne, writeStandardOutput } from "#platform/terminal/index.js";

/** Runtime choice for user-level init. "auto" leaves the runtime unset. */
export type RuntimeSelection = RuntimeId | "auto";

const AUTO_DETECT_LABEL = "Auto-detect";
const NAME_WIDTH = 16;

function formatStatus(probe: RuntimeProbe): string {
  switch (probe.status) {
    case "running":
      return chalk.green(
        `✓ running${probe.version ? ` (${probe.version})` : ""}`,
      );
    case "not-running":
      return chalk.yellow("⚠ not running");
    case "not-installed":
      return chalk.dim("✗ not installed");
  }
}

function toChoice(probe: RuntimeProbe) {
  const value: RuntimeSelection = probe.runtime;
  return {
    value,
    name: `${probe.runtime.padEnd(NAME_WIDTH)} ${formatStatus(probe)}`,
    short: probe.runtime,
    disabled: probe.status === "not-installed",
  };
}

function preselect(
  probes: readonly RuntimeProbe[],
  configured: RuntimeId | undefined,
): RuntimeSelection {
  const configuredProbe = probes.find((probe) => probe.runtime === configured);
  if (configuredProbe && configuredProbe.status !== "not-installed") {
    return configuredProbe.runtime;
  }
  return probes.find((probe) => probe.status === "running")?.runtime ?? "auto";
}

function warnNotRunning(probe: RuntimeProbe): void {
  writeStandardOutput(
    `${chalk.yellow("⚠")} ${chalk.cyan(probe.runtime)} is not running. Start it before you use Sandbox.`,
  );
  if (probe.hint) writeStandardOutput(`  ${probe.hint}`);
}

/**
 * Asks for the container runtime and shows the status of each runtime.
 * Pre-selects the configured runtime, then the first running one, then
 * "Auto-detect".
 */
export async function selectRuntime(
  configured: RuntimeId | undefined,
): Promise<RuntimeSelection> {
  const probes = await getRuntimeProvider().probe();
  const selection = await selectOne<RuntimeSelection>({
    message: "Select the container runtime:",
    choices: [
      ...probes.map(toChoice),
      {
        value: "auto",
        name: `${AUTO_DETECT_LABEL.padEnd(NAME_WIDTH)} ${chalk.dim("Use the first running runtime at each start")}`,
        short: AUTO_DETECT_LABEL,
      },
    ],
    default: preselect(probes, configured),
    loop: false,
  });
  const selectedProbe = probes.find((probe) => probe.runtime === selection);
  if (selectedProbe?.status === "not-running") warnNotRunning(selectedProbe);
  return selection;
}
