import path from "node:path";
import { getSandboxEnvironment } from "#platform/environment/index.js";
import {
  copyPathFollowingLinks,
  ensureDirectory,
  pathExists,
  removePath,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { parseSettingsManifest } from "./settings-manifest.js";

interface SettingsCopy {
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
}

function createSettingsCopy(options: {
  readonly configuredPath: string;
  readonly settingsDirectory: string;
  readonly homeDirectory: string;
}): SettingsCopy {
  const relativePath = options.configuredPath.replace(/\/$/, "");
  return {
    relativePath,
    sourcePath: path.join(options.settingsDirectory, relativePath),
    destinationPath: path.join(options.homeDirectory, relativePath),
  };
}

export async function applyContainerStartSettings(): Promise<void> {
  const environment = getSandboxEnvironment();
  const manifest = parseSettingsManifest(
    environment.variables.SANDBOX_SETTINGS,
  );
  const settingsDirectory = path.join(
    environment.filesystemRoot,
    "etc",
    "sandbox",
    "settings",
  );

  const copies = manifest.copyPaths.map((configuredPath) =>
    createSettingsCopy({
      configuredPath,
      settingsDirectory,
      homeDirectory: environment.homeDirectory,
    }),
  );
  for (const { relativePath, sourcePath, destinationPath } of copies) {
    if (!pathExists(sourcePath)) {
      getLogger().debug(
        `Skipped copied setting ~/${relativePath}: host source does not exist`,
      );
      continue;
    }
    removePath(destinationPath);
    ensureDirectory(path.dirname(destinationPath));
    try {
      copyPathFollowingLinks(sourcePath, destinationPath);
    } catch (error) {
      throw new Error(`Failed to copy setting ~/${relativePath}`, {
        cause: error,
      });
    }
    getLogger().debug(`Copied setting ~/${relativePath}`);
  }
}
