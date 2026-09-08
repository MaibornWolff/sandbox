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
import { checkX11, displayX11Status } from "./x11-check.js";

export async function doctorCommand(): Promise<void> {
  getConfigurationService();
  getClock().now();
  getTerminal().stdout.write(`${chalk.bold("Sandbox Doctor\n")}\n`);
  const summary: DoctorSummary = { errors: 0, warnings: 0 };

  const dockerResult = await checkDocker();
  displayDockerStatus(dockerResult);
  summary.errors += dockerResult.errors.length;
  summary.warnings += dockerResult.warnings.length;

  const x11Result = await checkX11();
  displayX11Status(x11Result);
  summary.warnings += x11Result.warnings.length;

  const configurationResult = checkConfigurationDiagnostics();
  displayConfigurationDiagnostics(configurationResult);
  summary.errors += configurationResult.errors.length;
  summary.warnings += configurationResult.warnings.length;

  const settingsResult = await checkSettingsDiagnostics();
  displaySettingsDiagnostics(settingsResult);
  summary.warnings += settingsResult.warnings.length;

  displayDoctorSummary(summary);
}
