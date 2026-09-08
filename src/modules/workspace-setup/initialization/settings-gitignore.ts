import * as path from "node:path";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import {
  ensureDirectory,
  pathExists,
  writeTextFile,
} from "#platform/filesystem/index.js";

const SETTINGS_GITIGNORE = `# Credential files - do not commit
credentials.json
.credentials.json
auth.json
`;

/**
 * Ensure .gitignore exists in settings directory to protect credentials
 * @testonly
 */
export function ensureSettingsGitignore(): void {
  const settingsDir = getSandboxSettings().getHostDirectory();
  const gitignorePath = path.join(settingsDir, ".gitignore");

  // Create settings directory if it doesn't exist
  if (!pathExists(settingsDir)) {
    ensureDirectory(settingsDir);
  }

  // Create .gitignore if it doesn't exist
  if (!pathExists(gitignorePath)) {
    writeTextFile(gitignorePath, SETTINGS_GITIGNORE);
  }
}
