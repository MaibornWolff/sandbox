import chalk from "chalk";
import { getConfigurationService } from "#modules/configuration/index.js";
import { getClock } from "#platform/clock/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { checkConfigurationDiagnostics } from "./configuration-diagnostics.js";
import { checkDocker, displayDockerStatus } from "./docker-check.js";
import {
  type DoctorSummary,
  displayConfigurationDiagnostics,
  displayDoctorSummary,
  displaySettingsDiagnostics,
} from "./doctor-display.js";
import { checkSettingsDiagnostics } from "./settings-diagnostics.js";

export async function doctorCommand(): Promise<void> {
  getConfigurationService();
  getClock().now();
  getTerminal().stdout.write(`${chalk.bold("Sandbox Doctor\n")}\n`);
  const summary: DoctorSummary = { errors: 0, warnings: 0 };

  const dockerResult = await checkDocker();
  displayDockerStatus(dockerResult);
  summary.errors += dockerResult.errors.length;
  summary.warnings += dockerResult.warnings.length;

  getTerminal().stdout.write(
    "Clipboard access is automatic for attached sessions. Host clipboard access is not checked.\n\n",
  );

  const configurationResult = checkConfigurationDiagnostics();
  displayConfigurationDiagnostics(configurationResult);
  summary.errors += configurationResult.errors.length;
  summary.warnings += configurationResult.warnings.length;

  const settingsResult = await checkSettingsDiagnostics();
  displaySettingsDiagnostics(settingsResult);
  summary.warnings += settingsResult.warnings.length;

  displayDoctorSummary(summary);
}
