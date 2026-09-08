import { runGlobalPackageBinary } from "#platform/npm/index.js";

/** Run template migration through the newly installed Sandbox executable. */
export async function updateInstalledTemplates(): Promise<void> {
  await runGlobalPackageBinary("sandbox", ["config", "update"]);
}
