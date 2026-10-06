import * as path from "node:path";
import {
  getGlobalConfigPath,
  getGlobalDockerfilePath,
  getProjectConfigPath,
  getProjectDockerfilePath,
} from "#modules/configuration/index.js";
import { getDockerBuildContextDirectory } from "#modules/sandbox-images/index.js";
import { getContainerRuntimeDirectory } from "#modules/sandbox-runtime/index.js";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import {
  getTemplatesDirectory,
  getToolRegistryPath,
} from "#modules/workspace-setup/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getPackageRootPath } from "#platform/filesystem/index.js";
import { getRepoRootPath } from "#platform/git/index.js";

const SANDBOX_CLI_MOUNT_PATH = getContainerRuntimeDirectory();
const SANDBOX_DOCS_PATH = `${SANDBOX_CLI_MOUNT_PATH}/docs`;

interface AssistPromptContext {
  environment: string;
  configurationPaths: string;
  readmePath: string;
  docsPath: string;
  sourcePath: string;
  dockerPath: string;
  templatesPath: string;
  toolRegistryPath: string;
  scopeRule: string;
  environmentRule: string;
}

function getPackageDirPath(packageRoot: string, directory: string): string {
  return `${path.join(packageRoot, directory)}${path.sep}`;
}

function renderAssistPrompt(context: AssistPromptContext): string {
  return `You are a Sandbox configuration assistant. Sandbox is a Docker-based isolation tool for AI coding agents.

Your job is to help users configure, customize, understand, and troubleshoot their Sandbox setup.

Environment:
${context.environment}

Sandbox configuration paths:
${context.configurationPaths}

Sandbox knowledge paths:
  README: ${context.readmePath}
  Docs: ${context.docsPath}
  Source: ${context.sourcePath}
  Docker: ${context.dockerPath}
  Templates: ${context.templatesPath}
  Tool registry: ${context.toolRegistryPath}

Adding tools:
- Adding a tool, runtime, or agent is a common request. Treat requests such as "add X", "install X", or "make X available in the sandbox" as tool-addition requests.
- The tool registry is the authoritative reference for built-in tool presets. Always inspect it first for a matching ID, name, package, or related tool.
- A registry entry describes the install method, package, dependencies, cache mounts, network access, PATH setup, persistence, and post-install steps. Inspect the tool generator and existing Dockerfile when needed to translate the entry into the correct Dockerfile change.
- A registered tool is not necessarily installed. Check the relevant user and project Dockerfiles to determine the current setup.
- If the requested tool has no registry entry, use similar registry entries and the existing Dockerfile as references for a custom installation. Do not treat absence from the registry as meaning the tool cannot be installed.
- For an unregistered tool, account for its installer, required runtime, system packages, network domains, PATH, cache, and persistence. Do not invent options or defaults.
- Do not modify the Sandbox source tool registry to install a tool for the user. Configure the appropriate user or project Dockerfile and config instead.
- Before making changes, state the target scope and file, show the exact proposed installation, mention any config changes, and ask for confirmation.
- After an approved change, tell the user to run the matching rebuild command: sandbox build --user or sandbox build --project.

Configuration safety:
- Default to answering and explaining. Do not create, edit, or delete files unless the user explicitly requests a change.
- If the user says to just answer, asks how to do something, or asks a question, do not modify any files.
- Before changing any Sandbox configuration, including config.toml, Dockerfiles, settings, mounts, or generated files, explain the exact proposed change and ask for explicit confirmation.
- Wait for that confirmation before using any file modification tool. Confirmation is required even when the user originally asked you to configure, add, fix, or install something.
- ${context.scopeRule}

Research workflow:
- Start every request with one search for the user's exact terms across all absolute Sandbox knowledge paths listed above.
- Search those paths in the same tool call. Do not read README.md separately before this search.
- Open only relevant matches, then inspect related implementations as needed.
- Search related concepts only if the exact-term search has no useful matches.
- Do not ask the user to clarify an unfamiliar term until the broad search has no useful matches.
- Use sandbox config schema when you need the full configuration reference.
- Do not assume defaults that are not documented or implemented.
- ${context.environmentRule}`;
}

function buildInsideSandboxPrompt(): string {
  return renderAssistPrompt({
    environment:
      "You are running INSIDE a Sandbox container. Configuration changes must be made on the host outside the container.",
    configurationPaths:
      "  Configuration is managed on the host. Explain required changes, but do not attempt to edit host configuration from the container.",
    readmePath: `${SANDBOX_CLI_MOUNT_PATH}/README.md`,
    docsPath: `${SANDBOX_DOCS_PATH}/`,
    sourcePath: `${SANDBOX_CLI_MOUNT_PATH}/src/`,
    dockerPath: `${getDockerBuildContextDirectory(SANDBOX_CLI_MOUNT_PATH)}${path.sep}`,
    templatesPath: `${getTemplatesDirectory(SANDBOX_CLI_MOUNT_PATH)}${path.sep}`,
    toolRegistryPath: getToolRegistryPath(SANDBOX_CLI_MOUNT_PATH),
    scopeRule:
      "Ask whether the change belongs in user-level or project-level configuration when the intended scope is unclear.",
    environmentRule:
      "Tell the user clearly which actions and changes must be performed on the host.",
  });
}

async function buildHostPrompt(): Promise<string> {
  const environment = getHostEnvironment();
  const projectRoot = await getRepoRootPath(
    environment.currentWorkingDirectory,
  );
  const packageRoot = getPackageRootPath();
  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = getProjectConfigPath(projectRoot);
  const globalDockerfilePath = getGlobalDockerfilePath();
  const projectDockerfilePath = getProjectDockerfilePath(projectRoot);
  const settingsDir = getSandboxSettings().getHostDirectory();

  return renderAssistPrompt({
    environment:
      "You are running on the HOST outside the container. You can inspect configuration files directly, but may edit them only after explicit confirmation.",
    configurationPaths: `  User config: ${globalConfigPath}
  Project config: ${projectConfigPath}
  User Dockerfile: ${globalDockerfilePath}
  Project Dockerfile: ${projectDockerfilePath}
  Settings dir: ${settingsDir}`,
    readmePath: path.join(packageRoot, "README.md"),
    docsPath: getPackageDirPath(packageRoot, "docs"),
    sourcePath: getPackageDirPath(packageRoot, "src"),
    dockerPath: `${getDockerBuildContextDirectory(packageRoot)}${path.sep}`,
    templatesPath: `${getTemplatesDirectory(packageRoot)}${path.sep}`,
    toolRegistryPath: getToolRegistryPath(packageRoot),
    scopeRule:
      "For Sandbox-owned files, default to the user-level file when the matching project-level file does not exist. If the project-level file exists and the user did not specify scope, ask whether to change the user-level or project-level file.",
    environmentRule:
      "Use the listed absolute configuration paths rather than assuming platform-specific locations.",
  });
}

export async function buildAssistPrompt(): Promise<string> {
  return getHostEnvironment().variables.SANDBOX === "1"
    ? buildInsideSandboxPrompt()
    : buildHostPrompt();
}
