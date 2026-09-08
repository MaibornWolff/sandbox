import * as path from "node:path";
import { readTextFile } from "#platform/filesystem/index.js";
import { getTemplatesDirectory } from "../workspace-asset-paths.js";

/**
 * Load a template file by name
 * @param name Template filename (e.g., 'config.toml', 'project-config.toml', '.gitignore')
 * @testonly
 */
export function loadTemplate(name: string): string {
  const templatesDir = getTemplatesDirectory();
  const templatePath = path.join(templatesDir, name);
  return readTextFile(templatePath);
}

export const CONFIG_TOML_TEMPLATE = loadTemplate("config.toml");
export const PROJECT_CONFIG_TOML_TEMPLATE = loadTemplate("project-config.toml");
/** @testonly */
export const GITIGNORE_TEMPLATE = loadTemplate("gitignore.template");
