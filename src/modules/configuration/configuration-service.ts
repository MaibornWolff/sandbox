import { getClock } from "#platform/clock/index.js";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists } from "#platform/filesystem/index.js";
import { resolveRepositoryContext } from "#platform/git/index.js";
import { getLogger } from "#platform/logging/index.js";
import { promptConfirmation } from "#platform/terminal/index.js";
import {
  injectAllowedDomains,
  readNetworkConfigFile,
  writeNetworkConfigFile,
} from "./allowed-network-config-update.js";
import type { ConfigOverrides, RuntimeId } from "./config.js";
import { applyCliOptions } from "./config-cli-overrides.js";
import { createConfigFromDefaults } from "./config-defaults.js";
import { applyTomlConfig } from "./config-merging.js";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  getProjectSandboxDir,
} from "./config-paths.js";
import type { LoadConfigResult } from "./load-config-result.js";
import {
  getTrustStorePath,
  isProjectTrusted,
  trustProject,
} from "./project-trust.js";
import { loadTomlConfig } from "./toml-config-loading.js";
import { formatTrustPrompt } from "./trust-prompt.js";

type ConfigTarget = "global" | "project";

interface ConfigurationService {
  load(options: ConfigOverrides): Promise<LoadConfigResult>;
  updateAllowedNetwork(options: {
    readonly target: ConfigTarget;
    readonly projectRoot: string;
    readonly domains: readonly string[];
  }): void;
}

const configurationServiceDependency = createDependency<ConfigurationService>(
  "configuration service",
);

export function provideConfigurationService(
  service: ConfigurationService,
): DependencyBinding {
  return configurationServiceDependency.provide(service);
}

export function getConfigurationService(): ConfigurationService {
  return configurationServiceDependency.get();
}

class ConfigurationExitError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
  }
}

export function createConfigurationService(): ConfigurationService {
  const environment = getHostEnvironment();
  const logger = getLogger();
  const clock = getClock();
  const globalConfigPath = getGlobalConfigPath();
  const trustStorePath = getTrustStorePath();

  function trust(projectRoot: string, sandboxDir: string): void {
    trustProject(
      projectRoot,
      sandboxDir,
      trustStorePath,
      new Date(clock.now()).toISOString(),
    );
  }

  async function promptTrust(
    sandboxDir: string,
    reason: "no-entry" | "hash-mismatch",
  ): Promise<boolean> {
    logger.warn(
      reason === "no-entry"
        ? `Found project config at ${sandboxDir}`
        : `Project config has changed: ${sandboxDir}`,
    );
    const accepted = await promptConfirmation(formatTrustPrompt());
    if (accepted) logger.success("Project config trusted");
    return accepted;
  }

  async function checkProjectTrust(
    projectRoot: string,
    sandboxDir: string,
    options: ConfigOverrides,
  ): Promise<void> {
    if (options.trust || environment.variables.SANDBOX_TRUST_ALL === "1") {
      trust(projectRoot, sandboxDir);
      return;
    }
    const result = isProjectTrusted(projectRoot, sandboxDir, trustStorePath);
    if (result.trusted) return;
    if (!environment.interactive) {
      logger.error(
        `Untrusted project config at ${sandboxDir}.\n  Use --trust or set SANDBOX_TRUST_ALL=1 to bypass.`,
      );
      throw new ConfigurationExitError("Project config is not trusted.");
    }
    const accepted = await promptTrust(
      sandboxDir,
      result.reason === "hash-mismatch" ? "hash-mismatch" : "no-entry",
    );
    if (!accepted) {
      logger.error("Project config not trusted. Exiting.");
      throw new ConfigurationExitError("Project config is not trusted.");
    }
    trust(projectRoot, sandboxDir);
  }

  return {
    async load(options) {
      logger.startTiming("Load configuration");
      const repositoryContext = await resolveRepositoryContext(
        environment.currentWorkingDirectory,
      );
      const { projectRoot, ...repositoryRoots } = repositoryContext;
      const globalConfig = loadTomlConfig(globalConfigPath);
      const sandboxDir = getProjectSandboxDir(projectRoot);
      if (pathExists(sandboxDir))
        await checkProjectTrust(projectRoot, sandboxDir, options);
      const projectConfig = loadTomlConfig(getProjectConfigPath(projectRoot));
      const configuredRuntime: RuntimeId | undefined =
        projectConfig?.runtime ?? globalConfig?.runtime;
      const config = createConfigFromDefaults(configuredRuntime ?? "docker");
      if (globalConfig) {
        await applyTomlConfig(
          config,
          globalConfig,
          "global",
          projectRoot,
          environment.variables,
        );
      }
      if (projectConfig) {
        await applyTomlConfig(
          config,
          projectConfig,
          "project",
          projectRoot,
          environment.variables,
        );
      }
      applyCliOptions(config, options, projectRoot, environment.variables);
      if (config.noProxy && !config.fullNetwork) {
        logger.error("--no-proxy requires --full-network to be enabled.");
        throw new ConfigurationExitError("Invalid network configuration.");
      }
      logger.endTiming("Load configuration");
      return {
        config,
        projectRoot,
        repositoryRoots,
        ...(configuredRuntime ? { configuredRuntime } : {}),
      };
    },
    updateAllowedNetwork(options) {
      const targetPath =
        options.target === "project"
          ? getProjectConfigPath(options.projectRoot)
          : globalConfigPath;
      const content = readNetworkConfigFile(targetPath);
      writeNetworkConfigFile(
        targetPath,
        injectAllowedDomains(content, [...options.domains]),
      );
    },
  };
}
