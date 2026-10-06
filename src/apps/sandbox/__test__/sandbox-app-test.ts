import * as fs from "node:fs";
import * as path from "node:path";
import {
  readConfigFixture,
  writeTrustedProjectConfig,
} from "#modules/configuration/__test__/index.js";
import type { AllowedNetwork, Config } from "#modules/configuration/index.js";
import {
  createNetworkObservationFixture,
  type NetworkObservationFixture,
} from "#modules/network-diagnostics/__test__/index.js";
import {
  createSelfUpdateFixture,
  type SelfUpdateFixture,
} from "#modules/self-update/__test__/index.js";
import {
  createTestClock,
  type TestClock,
} from "#platform/clock/__test__/index.js";
import { provideClock } from "#platform/clock/index.js";
import {
  createStatefulContainerRuntimeHarness,
  type ManagedContainer,
  type ManagedContainerStatus,
  type StatefulContainerRuntimeHarness,
} from "#platform/container-runtime/__test__/index.js";
import {
  createProductionRuntimeProvider,
  provideRuntimeProvider,
} from "#platform/container-runtime/index.js";
import {
  type DependencyBinding,
  runWithDependencies,
} from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import {
  createProcessTestHarness,
  type ProcessTestHarness,
} from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import {
  createEditorFixture,
  createTestTerminal,
  type EditorFixture,
  type TestTerminal,
  type TestTerminalUser,
} from "#platform/terminal/__test__/index.js";
import { provideTerminal } from "#platform/terminal/index.js";
import {
  createNodeWebSocketService,
  provideWebSocketService,
} from "#platform/websocket/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import { createHostGitFixture } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createSandboxApplication } from "../application.js";
import {
  type AssistanceFixture,
  createAssistanceFixture,
} from "./assistance.js";
import {
  createHostDiagnosticsFixture,
  type HostDiagnosticsFixture,
} from "./host-diagnostics.js";

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface SandboxAppTestOptions {
  readonly variables?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly runtime?: "apple-container" | "docker" | "podman";
  readonly runtimeBoundary?: "stateful" | "process";
  readonly workspaceAtHome?: boolean;
}

export interface SandboxAppTest {
  readonly cli: {
    run(...args: string[]): Promise<CliResult>;
  };
  readonly project: {
    readonly root: string;
    givenConfig(config: {
      readonly allowNetwork: readonly AllowedNetwork[];
      readonly runtime?: "apple-container" | "docker" | "podman";
    }): Promise<void>;
    writeConfig(
      content: string,
      options?: { readonly trusted?: boolean },
    ): void;
    writeDockerfile(content: string): void;
    givenPersistentData(files?: Readonly<Record<string, string>>): void;
    persistentDataExists(): boolean;
    givenContainer(options: {
      readonly state: Exclude<ManagedContainerStatus, "removed">;
      readonly uptime?: string;
      readonly hash?: string;
      readonly sessions?: readonly {
        readonly pid: string;
        readonly command: string;
      }[];
    }): {
      readonly id: string;
      readonly container: ManagedContainer;
      readonly network: NetworkObservationFixture;
    };
    readConfig(): Promise<Config>;
    configExists(): boolean;
    makeConfigWriteFail(): void;
  };
  readonly workspace: {
    readonly root: string;
    readonly homeRoot: string;
    readonly configRoot: string;
    readonly dataRoot: string;
    readonly git: ReturnType<typeof createHostGitFixture>;
    writeHomeFile(relativePath: string, content: string): void;
    writeRootFile(relativePath: string, content: string): void;
    writeExecutable(name: string): void;
    readHomeFile(relativePath: string): string;
    readConfigFile(relativePath: string): string;
    readProjectFile(relativePath: string): string;
    readDataFile(relativePath: string): string;
    configFileExists(relativePath: string): boolean;
    projectFileExists(relativePath: string): boolean;
    dataFileExists(relativePath: string): boolean;
    removeDataFile(relativePath: string): void;
  };
  readonly global: {
    readConfig(): Promise<Config>;
    writeConfig(content: string): void;
    writeDockerfile(content: string): void;
    givenSettings(files?: Readonly<Record<string, string>>): void;
    makeConfigWriteFail(): void;
  };
  readonly tui: {
    readonly user: TestTerminalUser;
    waitForText(text: string): Promise<void>;
    screen(): string;
    output(): string;
    cancel(): void;
  };
  readonly runtime: StatefulContainerRuntimeHarness;
  readonly clock: TestClock;
  readonly processes: ProcessTestHarness;
  readonly updates: SelfUpdateFixture;
  readonly editor: EditorFixture;
  readonly assistance: AssistanceFixture;
  readonly diagnostics: HostDiagnosticsFixture;
  [Symbol.asyncDispose](): Promise<void>;
}

function configureInitialDiagnosticsState(
  environment: ReturnType<typeof createHostEnvironment>,
  processes: ProcessTestHarness,
): void {
  const displayNumber =
    environment.variables.DISPLAY?.match(/:(\d+)/)?.[1] ?? "0";
  const notFound = { exitCode: 1, stdout: "", stderr: "not found" };
  processes
    .expectStart({
      match: {
        command: "test",
        args: ["-e", `/tmp/.X11-unix/X${displayNumber}`],
      },
    })
    .resolveResult(notFound);
  processes
    .expectStart({
      match: {
        command: "test",
        args: ["-d", "/Applications/Utilities/XQuartz.app"],
      },
    })
    .resolveResult(notFound);
}

function startedAtFromUptime(uptime: string | undefined): Date {
  const match = uptime?.match(/^Up (\d+) (minute|minutes|hour|hours)$/u);
  const amount = Number(match?.[1] ?? 1);
  const unitMilliseconds = match?.[2]?.startsWith("hour")
    ? 60 * 60 * 1_000
    : 60 * 1_000;
  return new Date(Date.UTC(2026, 0, 1) - amount * unitMilliseconds);
}

function createProjectFixture(options: {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly dataRoot: string;
  readonly runtime: StatefulContainerRuntimeHarness;
  readonly readConfig: (filePath: string) => Config;
}): SandboxAppTest["project"] {
  const { projectRoot, configRoot, dataRoot, runtime } = options;
  let nextProjectContainer = 1;
  return {
    root: projectRoot,
    async givenConfig(config) {
      writeTrustedProjectConfig({
        projectRoot,
        trustStorePath: path.join(configRoot, "trusted-projects.json"),
        allowNetwork: config.allowNetwork,
        ...(config.runtime ? { runtime: config.runtime } : {}),
      });
    },
    writeConfig(content, configOptions = {}) {
      const sandboxDirectory = path.join(projectRoot, ".sandbox");
      fs.mkdirSync(sandboxDirectory, { recursive: true });
      fs.writeFileSync(path.join(sandboxDirectory, "config.toml"), content);
      if (configOptions.trusted) {
        writeTrustedProjectConfig({
          projectRoot,
          trustStorePath: path.join(configRoot, "trusted-projects.json"),
          content,
        });
      }
    },
    writeDockerfile(content) {
      const dockerDirectory = path.join(projectRoot, ".sandbox", "docker");
      fs.mkdirSync(dockerDirectory, { recursive: true });
      fs.writeFileSync(path.join(dockerDirectory, "Dockerfile"), content);
    },
    givenPersistentData(files = {}) {
      const persistRoot = path.join(
        dataRoot,
        "sandbox",
        generateProjectSlug(projectRoot),
      );
      fs.mkdirSync(persistRoot, { recursive: true });
      for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(persistRoot, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      }
    },
    persistentDataExists() {
      return fs.existsSync(
        path.join(dataRoot, "sandbox", generateProjectSlug(projectRoot)),
      );
    },
    givenContainer(containerOptions) {
      const suffix = nextProjectContainer++;
      const projectSlug = generateProjectSlug(projectRoot);
      const baseName = `sandbox-${projectSlug}`;
      const container = runtime.instances.create({
        name: suffix === 1 ? baseName : `${baseName}-${suffix}`,
        image: `sandbox-${projectSlug}:latest`,
        labels: {
          "sandbox.project": projectSlug,
          ...(containerOptions.hash
            ? { "sandbox.hash": containerOptions.hash }
            : {}),
        },
        status: containerOptions.state,
        startedAt: startedAtFromUptime(containerOptions.uptime),
        ...(containerOptions.uptime ? { uptime: containerOptions.uptime } : {}),
      });
      if (containerOptions.sessions) {
        container.givenExecResult(
          [
            "sh",
            "-c",
            'for f in /tmp/sandbox-sessions/*; do   [ -f "$f" ] || continue;   pid=$(basename "$f");   kill -0 "$pid" 2>/dev/null || { rm -f "$f"; continue; };   cmd=$(tr "\\0" " " < /proc/$pid/cmdline 2>/dev/null | head -c 200);   echo "$pid|$cmd"; done',
          ],
          containerOptions.sessions
            .map((session) => `${session.pid}|${session.command}`)
            .join("\n"),
        );
      }
      return {
        id: container.id,
        container,
        network: createNetworkObservationFixture(container),
      };
    },
    async readConfig() {
      return options.readConfig(
        path.join(projectRoot, ".sandbox", "config.toml"),
      );
    },
    configExists() {
      return fs.existsSync(path.join(projectRoot, ".sandbox", "config.toml"));
    },
    makeConfigWriteFail() {
      const configPath = path.join(projectRoot, ".sandbox", "config.toml");
      fs.rmSync(configPath, { force: true });
      fs.mkdirSync(configPath, { recursive: true });
    },
  };
}

function createGlobalFixture(
  configRoot: string,
  readConfig: (filePath: string) => Config,
): SandboxAppTest["global"] {
  return {
    async readConfig() {
      return readConfig(path.join(configRoot, "config.toml"));
    },
    writeConfig(content) {
      fs.mkdirSync(configRoot, { recursive: true });
      fs.writeFileSync(path.join(configRoot, "config.toml"), content);
    },
    writeDockerfile(content) {
      const dockerDirectory = path.join(configRoot, "docker");
      fs.mkdirSync(dockerDirectory, { recursive: true });
      fs.writeFileSync(path.join(dockerDirectory, "Dockerfile"), content);
    },
    givenSettings(files = {}) {
      const settingsRoot = path.join(configRoot, "settings");
      fs.mkdirSync(settingsRoot, { recursive: true });
      for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(settingsRoot, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      }
    },
    makeConfigWriteFail() {
      const configPath = path.join(configRoot, "config.toml");
      fs.rmSync(configPath, { recursive: true, force: true });
      fs.mkdirSync(configPath, { recursive: true });
    },
  };
}

function createWorkspaceRoots(workspaceAtHome: boolean): {
  readonly root: string;
  readonly homeRoot: string;
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly dataRoot: string;
  readonly executableRoot: string;
} {
  const root = createTestDir("sandbox-app-test");
  const homeRoot = path.join(root, "home");
  const roots = {
    root,
    homeRoot,
    projectRoot: workspaceAtHome ? homeRoot : path.join(root, "project"),
    configRoot: path.join(root, "config"),
    dataRoot: path.join(root, "data"),
    executableRoot: path.join(root, "bin"),
  };
  for (const directory of Object.values(roots)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return roots;
}

export async function setupSandboxAppTest(
  options: SandboxAppTestOptions = {},
): Promise<SandboxAppTest> {
  const { root, homeRoot, projectRoot, configRoot, dataRoot, executableRoot } =
    createWorkspaceRoots(options.workspaceAtHome ?? false);

  const terminal: TestTerminal = createTestTerminal({
    columns: 100,
    rows: 30,
    timeoutMs: 3_000,
  });
  const environment = createHostEnvironment({
    currentWorkingDirectory: projectRoot,
    homeDirectory: homeRoot,
    variables: {
      SANDBOX_CONFIG_DIR: configRoot,
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: dataRoot,
      PATH: executableRoot,
      ...options.variables,
    },
    platform: options.platform ?? "linux",
    interactive: options.interactive ?? true,
  });
  const runtime = createStatefulContainerRuntimeHarness({
    runtime: options.runtime ?? "docker",
  });
  const clock = createTestClock(Date.UTC(2026, 0, 1));
  const processes = createProcessTestHarness();
  const runtimeProvider =
    options.runtimeBoundary === "process"
      ? createProductionRuntimeProvider(processes.manager)
      : runtime.provider;
  const updates = createSelfUpdateFixture(processes);
  updates.givenPackageVersion("@maibornwolff/sandbox", "0.0.0-development");
  updates.givenInstalledVersion("@maibornwolff/sandbox", "0.0.0-development");
  updates.givenGlobalBinary("sandbox");
  const git = createHostGitFixture(processes);
  git.givenNoRepository(projectRoot);
  const editor = createEditorFixture({
    processes,
    platform: environment.platform,
    environmentEditors: [
      ...(environment.variables.EDITOR ? [environment.variables.EDITOR] : []),
      ...(environment.variables.VISUAL ? [environment.variables.VISUAL] : []),
    ],
    cancel: () => terminal.abort(),
  });
  editor.givenAvailableEditors([]);
  const assistance = createAssistanceFixture({
    executableDirectory: executableRoot,
    processes,
    platform: environment.platform,
  });
  configureInitialDiagnosticsState(environment, processes);
  const logger = createLogger(
    clock.clock,
    (message) => terminal.io.stderr.write(`${message}\n`),
    {},
  );
  const executions = new Set<Promise<CliResult>>();
  const technicalBindings = (): readonly DependencyBinding[] => [
    provideHostEnvironment(environment),
    provideTerminal(terminal.io),
    provideClock(clock.clock),
    provideProcessManager(processes.manager),
    provideLogger(logger),
    provideRuntimeProvider(runtimeProvider),
    provideWebSocketService(createNodeWebSocketService()),
  ];

  return {
    cli: {
      run(...args) {
        if (executions.size > 0) {
          throw new Error(
            "Only one CLI execution may use an application terminal at a time.",
          );
        }
        git.prepare();
        updates.prepare();
        editor.prepare();
        const stdoutStart = terminal.stdout().length;
        const stderrStart = terminal.stderr().length;
        const execution = runWithDependencies(technicalBindings(), async () => {
          const exitCode = await createSandboxApplication().run(args);
          return {
            exitCode,
            stdout: terminal.stdout().slice(stdoutStart),
            stderr: terminal.stderr().slice(stderrStart),
          };
        });
        executions.add(execution);
        void execution.finally(() => executions.delete(execution));
        return execution;
      },
    },
    project: createProjectFixture({
      projectRoot,
      configRoot,
      dataRoot,
      runtime,
      readConfig: (filePath) =>
        runWithDependencies([provideLogger(logger)], () =>
          readConfigFixture(filePath),
        ),
    }),
    workspace: {
      root,
      homeRoot,
      configRoot,
      dataRoot,
      git,
      writeHomeFile(relativePath, content) {
        const filePath = path.join(homeRoot, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      },
      writeRootFile(relativePath, content) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      },
      writeExecutable(name) {
        const filePath = path.join(executableRoot, name);
        fs.writeFileSync(filePath, "test executable");
        fs.chmodSync(filePath, 0o755);
      },
      readHomeFile: (relativePath) =>
        fs.readFileSync(path.join(homeRoot, relativePath), "utf8"),
      readConfigFile: (relativePath) =>
        fs.readFileSync(path.join(configRoot, relativePath), "utf8"),
      readProjectFile: (relativePath) =>
        fs.readFileSync(path.join(projectRoot, relativePath), "utf8"),
      readDataFile: (relativePath) =>
        fs.readFileSync(path.join(dataRoot, relativePath), "utf8"),
      configFileExists: (relativePath) =>
        fs.existsSync(path.join(configRoot, relativePath)),
      projectFileExists: (relativePath) =>
        fs.existsSync(path.join(projectRoot, relativePath)),
      dataFileExists: (relativePath) =>
        fs.existsSync(path.join(dataRoot, relativePath)),
      removeDataFile(relativePath) {
        fs.rmSync(path.join(dataRoot, relativePath), {
          recursive: true,
          force: true,
        });
      },
    },
    global: createGlobalFixture(configRoot, (filePath) =>
      runWithDependencies([provideLogger(logger)], () =>
        readConfigFixture(filePath),
      ),
    ),
    tui: {
      user: terminal.user,
      waitForText: (text) => terminal.waitForText(text),
      screen: () => terminal.screen(),
      output: () => terminal.output(),
      cancel: () => terminal.abort(),
    },
    runtime,
    clock,
    processes,
    updates,
    editor,
    assistance,
    diagnostics: createHostDiagnosticsFixture(processes),
    async [Symbol.asyncDispose]() {
      terminal.abort();
      await Promise.allSettled([...executions]);
      await terminal.dispose();
      cleanupTestDir(root);
    },
  };
}
