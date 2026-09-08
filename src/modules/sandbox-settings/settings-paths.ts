import path from "node:path";
import { getSandboxConfigDir } from "#modules/configuration/index.js";

export function getSettingsDir(): string {
  return path.join(getSandboxConfigDir(), "settings");
}
