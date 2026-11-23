import { getClock } from "#platform/clock/index.js";
import type { RuntimeResolutionRequest } from "#platform/container-runtime/index.js";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists } from "#platform/filesystem/index.js";
import { resolveRepositoryContext } from "#platform/git/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getTerminal, promptConfirmation } from "#platform/terminal/index.js";
import {
  injectAllowedDomains,
  readNetworkConfigFile,
  writeNetworkConfigFile,
} from "./allowed-network-config-update.js";
import type { ConfigOverrides, RuntimeId } from "./config.js";
import { applyCliOptions } from "./config-cli-overrides.js";
import { createConfigFromDefaults } from "./config-defaults.js";
import { applyTomlConfig } from "./config-merging.js";
import { formatConfigPath } from "./config-path-display.js";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  getProjectSandboxDir,
} from "./config-paths.js";
import type { LoadConfigResult } from "./load-config-result.js";
import { resolveExistingMounts } from "./mount-path-resolution.js";
import { getTrustStorePath, inspectProjectTrust } from "./project-trust.js";
import { loadTomlConfig } from "./toml-config-loading.js";
import type { TomlConfig } from "./toml-config-schema.js";
import { formatProjectMountAccess, formatTrustPrompt } from "./trust-prompt.js";

type ConfigTarget = "global" | "project";

interface ConfigurationService {
  load(options: ConfigOverrides): Promise<LoadConfigResult>;
  /** Read runtime settings from the user config without project config or mounts. */
  loadUserRuntimeResolution(): RuntimeResolutionRequest;
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
}

function resolveTomlMounts(
  toml: TomlConfig | null,
  projectRoot: string,
  isProjectConfig: boolean,
): string[] {
  return resolveExistingMounts(
    toml?.mounts ?? [],
    projectRoot,
    isProjectConfig,
  );
}

export function createConfigurationService(): ConfigurationService {
  const environment = getHostEnvironment();
  const logger = getLogger();
  const clock = getClock();
  const globalConfigPath = getGlobalConfigPath();
  const trustStorePath = getTrustStorePath();

  async function promptTrust(
    sandboxDir: string,
    reason: "no-entry" | "hash-mismatch",
    mounts: readonly string[],
  ): Promise<boolean> {
    logger.warn(
      reason === "no-entry"
        ? `Found project config at ${formatConfigPath(sandboxDir)}`
        : `Project config or mount access has changed: ${formatConfigPath(sandboxDir)}`,
    );
    getTerminal().stderr.write(`${formatProjectMountAccess(mounts)}\n`);
    return promptConfirmation(formatTrustPrompt());
  }

  async function checkProjectTrust(options: {
    readonly projectRoot: string;
    readonly sandboxDir: string;
    readonly mounts: readonly string[];
    readonly trust: boolean;
  }): Promise<void> {
    const { projectRoot, sandboxDir, mounts } = options;
    const approval = inspectProjectTrust({
      projectRoot,
      sandboxDir,
      mounts,
      storePath: trustStorePath,
    });
    logger.debug(
      `Project trust: ${approval.reason} for ${formatConfigPath(projectRoot)}`,
    );
    if (options.trust || environment.variables.SANDBOX_TRUST_ALL === "1") {
      approval.approve(
        new Date(clock.now()).toISOString(),
        resolveExistingMounts(mounts, projectRoot, true),
      );
      return;
    }
    if (approval.trusted) return;
    if (!environment.interactive) {
      logger.error(
        `Untrusted project config at ${formatConfigPath(sandboxDir)}.\n  Use --trust or set SANDBOX_TRUST_ALL=1 to bypass.`,
      );
      throw new ConfigurationExitError("Project config is not trusted.");
    }
    const accepted = await promptTrust(
      sandboxDir,
      approval.reason === "hash-mismatch" ? "hash-mismatch" : "no-entry",
      mounts,
    );
    if (!accepted) {
      logger.error("Project config not trusted. Exiting.");
      throw new ConfigurationExitError("Project config is not trusted.");
    }
    approval.approve(
      new Date(clock.now()).toISOString(),
      resolveExistingMounts(mounts, projectRoot, true),
    );
    logger.success("Project config trusted");
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
      const projectConfig = loadTomlConfig(getProjectConfigPath(projectRoot));
      const configuredRuntime: RuntimeId | undefined =
        projectConfig?.runtime ?? globalConfig?.runtime;
      const config = createConfigFromDefaults(configuredRuntime ?? "docker");
      const projectMounts = resolveTomlMounts(projectConfig, projectRoot, true);
      if (pathExists(sandboxDir)) {
        await checkProjectTrust({
          projectRoot,
          sandboxDir,
          mounts: projectMounts,
          trust: options.trust ?? false,
        });
      }
      if (globalConfig) {
        applyTomlConfig({
          config,
          toml: globalConfig,
          source: "global",
          mounts: resolveTomlMounts(globalConfig, projectRoot, false),
          variables: environment.variables,
        });
      }
      if (projectConfig) {
        applyTomlConfig({
          config,
          toml: projectConfig,
          source: "project",
          mounts: projectMounts,
          variables: environment.variables,
        });
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
        runtimeResolution: {
          ...(configuredRuntime ? { configuredRuntime } : {}),
          options: config.runtimes,
        },
      };
    },
    loadUserRuntimeResolution() {
      const globalConfig = loadTomlConfig(globalConfigPath);
      const configuredRuntime = globalConfig?.runtime;
      const { runtimes } = createConfigFromDefaults(
        configuredRuntime ?? "docker",
      );
      const dns = globalConfig?.runtimes?.["apple-container"]?.dns;
      return {
        ...(configuredRuntime ? { configuredRuntime } : {}),
        options: dns === undefined ? runtimes : { "apple-container": { dns } },
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
