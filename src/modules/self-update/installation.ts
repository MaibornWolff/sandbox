import { getPackageRootPath } from "#platform/filesystem/index.js";

export const HOMEBREW_UPDATE_COMMAND = "brew upgrade sandbox";

/** Homebrew keeps formula files below `<prefix>/Cellar/<formula>/<version>`. */
export function isHomebrewInstallation(
  packageRoot: string = getPackageRootPath(),
): boolean {
  return packageRoot.replace(/\\/g, "/").includes("/Cellar/sandbox/");
}
