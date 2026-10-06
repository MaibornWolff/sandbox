import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArchitectureDefinition } from "./define-architecture.js";
import { scanSideEffects } from "./scan-side-effects.js";

const directories: string[] = [];
type Owner =
  | "apps/sandbox"
  | "modules/feature"
  | "platform/container-runtime"
  | "platform/container-system"
  | "platform/dependency-injection"
  | "platform/environment"
  | "platform/filesystem"
  | "platform/x11-clipboard"
  | "platform/websocket"
  | "platform/process"
  | "platform/terminal";

async function fixture(
  owner: Owner,
  source: string,
  relativeFile = "index.ts",
): Promise<{ architecture: ArchitectureDefinition; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-side-effects-"));
  directories.push(root);
  const [group, name] = owner.split("/") as [
    "apps" | "modules" | "platform",
    string,
  ];
  const componentDirectory = path.join(root, "src", owner);
  await mkdir(componentDirectory, { recursive: true });
  await writeFile(path.join(componentDirectory, relativeFile), source);
  if (relativeFile !== "index.ts") {
    await writeFile(
      path.join(componentDirectory, "index.ts"),
      "export const facade = true;\n",
    );
  }
  return {
    root,
    architecture: {
      apps: group === "apps" ? [{ name, dependencies: [] }] : [],
      modules: group === "modules" ? [{ name, dependencies: [] }] : [],
      platform: group === "platform" ? [{ name, dependencies: [] }] : [],
      shared: [],
      testApis: [],
      legacyRoots: [],
    },
  };
}

async function rules(
  owner: Owner,
  source: string,
  relativeFile?: string,
): Promise<string[]> {
  const result = await fixture(owner, source, relativeFile);
  return (await scanSideEffects(result.architecture, result.root)).map(
    ({ rule }) => rule,
  );
}

const dependencyContracts: Readonly<Record<string, string>> = {
  "src/modules/host-bridge/session.ts":
    'interface HostBridgeService { startSession(): void }\nconst dependency = createDependency<HostBridgeService>("Host bridge service");\nexport function provideHostBridgeService(value: HostBridgeService) { return dependency.provide(value); }\nexport function getHostBridgeService() { return dependency.get(); }\n',
  "src/modules/clipboard/host-capability.ts":
    'interface ClipboardCapabilityFactory { create(): void }\nconst dependency = createDependency<ClipboardCapabilityFactory>("clipboard capability factory");\nexport function provideClipboardCapabilityFactory(value: ClipboardCapabilityFactory) { return dependency.provide(value); }\nexport function getClipboardCapabilityFactory() { return dependency.get(); }\n',
  "src/modules/clipboard/proxy.ts":
    'interface ClipboardProxyRunner { run(): void }\nconst dependency = createDependency<ClipboardProxyRunner>("clipboard proxy runner");\nexport function provideClipboardProxyRunner(value: ClipboardProxyRunner) { return dependency.provide(value); }\nexport function getClipboardProxyRunner() { return dependency.get(); }\n',
  "src/modules/configuration/configuration-service.ts":
    'interface ConfigurationService { load(): void }\nconst configurationServiceDependency = createDependency<ConfigurationService>("configuration service");\nexport function provideConfigurationService(value: ConfigurationService) { return configurationServiceDependency.provide(value); }\nexport function getConfigurationService() { return configurationServiceDependency.get(); }\n',
  "src/platform/clock/clock.ts":
    'interface Clock { now(): number }\nconst clockDependency = createDependency<Clock>("clock");\nexport function provideClock(value: Clock) { return clockDependency.provide(value); }\nexport function getClock() { return clockDependency.get(); }\n',
  "src/platform/container-runtime/runtime-provider.ts":
    'interface ContainerRuntimeProvider { resolve(): void }\nconst runtimeProviderDependency = createDependency<ContainerRuntimeProvider>("container runtime provider");\nexport function provideRuntimeProvider(value: ContainerRuntimeProvider) { return runtimeProviderDependency.provide(value); }\nexport function getRuntimeProvider() { return runtimeProviderDependency.get(); }\n',
  "src/platform/container-system/tcp-service.ts":
    'interface TcpService { connect(): void }\nconst tcpServiceDependency = createDependency<TcpService>("TCP service");\nexport function provideTcpService(value: TcpService) { return tcpServiceDependency.provide(value); }\nexport function getTcpService() { return tcpServiceDependency.get(); }\n',
  "src/platform/environment/host-environment.ts":
    'interface HostEnvironment { readonly platform: string }\nconst hostEnvironmentDependency = createDependency<HostEnvironment>("host environment");\nexport function provideHostEnvironment(value: HostEnvironment) { return hostEnvironmentDependency.provide(value); }\nexport function getHostEnvironment() { return hostEnvironmentDependency.get(); }\n',
  "src/platform/environment/sandbox-environment.ts":
    'interface SandboxEnvironment { readonly home: string }\nconst sandboxEnvironmentDependency = createDependency<SandboxEnvironment>("sandbox environment");\nexport function provideSandboxEnvironment(value: SandboxEnvironment) { return sandboxEnvironmentDependency.provide(value); }\nexport function getSandboxEnvironment() { return sandboxEnvironmentDependency.get(); }\n',
  "src/platform/logging/logger.ts":
    'interface Logger { write(): void }\nconst loggerDependency = createDependency<Logger>("logger");\nexport function provideLogger(value: Logger) { return loggerDependency.provide(value); }\nexport function getLogger() { return loggerDependency.get(); }\n',
  "src/platform/process/process-manager.ts":
    'interface ProcessManager { stopAll(): void }\nconst processManagerDependency = createDependency<ProcessManager>("process manager");\nexport function provideProcessManager(value: ProcessManager) { return processManagerDependency.provide(value); }\nexport function getProcessManager() { return processManagerDependency.get(); }\n',
  "src/platform/terminal/terminal.ts":
    'interface Terminal { write(): void }\nconst terminalDependency = createDependency<Terminal>("terminal");\nexport function provideTerminal(value: Terminal) { return terminalDependency.provide(value); }\nexport function getTerminal() { return terminalDependency.get(); }\n',
  "src/platform/websocket/websocket-service.ts":
    'interface WebSocketService { connect(): void }\nconst webSocketServiceDependency = createDependency<WebSocketService>("WebSocket service");\nexport function provideWebSocketService(value: WebSocketService) { return webSocketServiceDependency.provide(value); }\nexport function getWebSocketService() { return webSocketServiceDependency.get(); }\n',
};

async function dependencyManifestFixture(
  replacements: Readonly<Record<string, string>> = {},
): Promise<{ architecture: ArchitectureDefinition; root: string }> {
  const root = await mkdtemp(
    path.join(tmpdir(), "sandbox-dependency-manifest-"),
  );
  directories.push(root);
  for (const [file, source] of Object.entries(dependencyContracts)) {
    const absoluteFile = path.join(root, file);
    await mkdir(path.dirname(absoluteFile), { recursive: true });
    await writeFile(
      absoluteFile,
      `import { createDependency } from "#platform/dependency-injection/index.js";\n${replacements[file] ?? source}`,
    );
  }
  return {
    root,
    architecture: {
      apps: [],
      modules: [{ name: "configuration", dependencies: [] }],
      platform: [
        "clock",
        "container-runtime",
        "container-system",
        "environment",
        "logging",
        "process",
        "terminal",
        "websocket",
      ].map((name) => ({ name, dependencies: [] })),
      shared: [],
      testApis: [],
      legacyRoots: [],
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scanSideEffects", () => {
  test("limits clipboard filesystem and network access to concrete adapters", async () => {
    const filesystem = 'import { mkdtemp } from "node:fs/promises";\n';
    expect(
      await rules("platform/x11-clipboard", filesystem, "display.ts"),
    ).toEqual([]);
    expect(
      await rules("platform/x11-clipboard", filesystem, "service.ts"),
    ).toContain("direct-filesystem-import");
    const network = 'import { connect } from "node:net";\n';
    expect(
      await rules("platform/x11-clipboard", network, "protocol.ts"),
    ).toEqual([]);
    expect(
      await rules("platform/x11-clipboard", network, "service.ts"),
    ).toContain("direct-network-I/O-import");
    const tls = 'import { createServer } from "node:https";\n';
    expect(await rules("platform/websocket", tls, "tls.ts")).toEqual([]);
    expect(await rules("platform/websocket", tls, "service.ts")).toContain(
      "direct-network-I/O-import",
    );
  });

  test("rejects direct filesystem, process, fetch, and console effects", async () => {
    expect(
      await rules(
        "modules/feature",
        'import { readFile } from "node:fs/promises";\nprocess.cwd();\nfetch("https://example.com");\nconsole.log("x");\nexport { readFile };\n',
      ),
    ).toEqual([
      "direct-filesystem-import",
      "direct-process-global",
      "direct-fetch",
      "direct-console",
    ]);
  });

  test("rejects cross-component re-exports even when the dependency is imported", async () => {
    const { architecture, root } = await fixture(
      "modules/feature",
      'import type { Value } from "../provider/index.js";\nexport type { Value } from "../provider/index.js";\n',
    );
    const providerDirectory = path.join(root, "src", "modules", "provider");
    await mkdir(providerDirectory, { recursive: true });
    await writeFile(
      path.join(providerDirectory, "index.ts"),
      "export interface Value { readonly value: string }\n",
    );
    const definition: ArchitectureDefinition = {
      ...architecture,
      modules: [
        { name: "feature", dependencies: ["provider"] },
        { name: "provider", dependencies: [] },
      ],
    };
    expect(await scanSideEffects(definition, root)).toContainEqual(
      expect.objectContaining({
        rule: "cross-component-re-export",
        detail: "modules/feature cannot re-export from modules/provider",
      }),
    );
  });

  test("allows safe type-only native imports and request values", async () => {
    expect(
      await rules(
        "modules/feature",
        'import type { Stats } from "node:fs";\ninterface Request { readonly formatter?: string }\nexport function run(request: Request = {}, configuredRuntime = "docker") { return { request, configuredRuntime }; }\nexport type { Stats };\n',
      ),
    ).toEqual([]);
  });

  test("rejects type-only child process handles outside the process owner", async () => {
    expect(
      await rules(
        "modules/feature",
        'import type { ChildProcess } from "node:child_process";\nexport type { ChildProcess };\n',
      ),
    ).toContain("direct-process-import");
  });

  test("rejects required and optional collaborators regardless of bag name", async () => {
    const result = await rules(
      "modules/feature",
      "interface FeatureService { run(): void }\ninterface FeatureDeps { readonly service?: FeatureService }\ninterface FeatureOptions { readonly execute: () => void }\ninterface FeatureContext { readonly service: FeatureService }\ninterface ArbitraryName { readonly worker: FeatureService }\nconst defaultService = {} as FeatureService;\nexport function run(service: FeatureService = defaultService) { service.run(); }\n",
    );
    expect(
      result.filter((rule) => rule === "collaborator-dependency-bag"),
    ).toHaveLength(4);
    expect(result).toContain("optional-collaborator-default");
  });

  test("allows request data and operation or lifecycle callbacks", async () => {
    expect(
      await rules(
        "modules/feature",
        "interface RequestOptions { readonly runtime: string; readonly retries?: number; readonly beforeSpawn?: () => void; readonly onResult: () => void }\ninterface ImmutableContext { readonly values: readonly string[]; readonly createdAt: number }\nexport function inScope(operation?: () => void, onResult?: () => void) { operation?.(); onResult?.(); }\nexport const request: RequestOptions = { runtime: 'docker', onResult() {} };\nexport const context: ImmutableContext = { values: [], createdAt: 1 };\n",
      ),
    ).toEqual([]);
  });

  test("rejects runtime construction and provider defaults outside ownership", async () => {
    const result = await rules(
      "modules/feature",
      "declare function createRuntimeService(): unknown;\ndeclare function createProductionRuntimeProvider(): unknown;\ncreateRuntimeService();\ncreateProductionRuntimeProvider();\n",
    );
    expect(result).toContain("container-runtime-construction-owner-only");
    expect(result).toContain("runtime-provider-composition-only");
  });

  test("allows runtime construction in its owner", async () => {
    expect(
      await rules(
        "platform/container-runtime",
        "declare function createRuntimeService(): unknown;\ncreateRuntimeService();\n",
      ),
    ).toEqual([]);
  });

  test("rejects legacy global hooks and mutable module registries", async () => {
    const result = await rules(
      "modules/feature",
      "declare function setLogger(value: unknown): void;\nsetLogger({});\nconst dependencyRegistry = new Map<string, unknown>();\n",
    );
    expect(result).toContain("legacy-global-dependency-hook");
    expect(result).toContain("mutable-module-dependency-state");
  });

  test("rejects clocks, timers, sockets, and broad child-process ownership", async () => {
    const result = await rules(
      "platform/terminal",
      'import { spawn } from "node:child_process";\nDate.now();\nnew Date();\nsetTimeout(() => {}, 1);\nnew WebSocket("ws://localhost");\nexport { spawn };\n',
    );
    expect(result).toContain("direct-process-import");
    expect(result.filter((rule) => rule === "direct-clock")).toHaveLength(2);
    expect(result).toContain("direct-timer");
    expect(result).toContain("direct-socket");
  });

  test("allows timers only in the concrete TCP adapter factory", async () => {
    const source =
      "export function createNodeTcpService() { const timeout = setTimeout(() => {}, 1); clearTimeout(timeout); }\n";
    expect(
      await rules("platform/container-system", source, "tcp-service.ts"),
    ).toEqual([]);
    expect(
      await rules("platform/container-system", source, "diagnostics.ts"),
    ).toContain("direct-timer");
    expect(
      await rules(
        "platform/container-system",
        "export function unrelated() { setTimeout(() => {}, 1); }\n",
        "tcp-service.ts",
      ),
    ).toContain("direct-timer");
  });

  test("allows process access only in its declared adapter factory", async () => {
    expect(
      await rules(
        "platform/terminal",
        "export function createProcessTerminal() { return process.stdin; }\nexport function readProcessTerminalStreams() { return [process.stdout, process.stderr]; }\n",
        "terminal.ts",
      ),
    ).toEqual([]);
    expect(
      await rules(
        "platform/terminal",
        "export function unrelated() { return process.stdin; }\n",
        "terminal.ts",
      ),
    ).toContain("direct-process-global");
  });

  test("allows child-process imports only in the process adapter file", async () => {
    expect(
      await rules(
        "platform/process",
        'export { spawn } from "node:child_process";\n',
        "node-process-adapter.ts",
      ),
    ).toEqual([]);
  });

  test("rejects raw process controls outside the process owner", async () => {
    const result = await rules(
      "modules/feature",
      "child.kill('SIGTERM');\nchild.sendSignal('SIGTERM');\nchild.unref();\nchild.subscribeToSignals([], () => undefined);\nchild.isRunning();\nprocess.kill(41, 0);\nprocess.on('SIGTERM', () => undefined);\n",
    );
    expect(
      result.filter((rule) => rule === "raw-process-control-owner-only"),
    ).toHaveLength(6);
    expect(
      result.filter((rule) => rule === "direct-process-global"),
    ).toHaveLength(2);
  });

  test("rejects test mutation of process environment and CWD", async () => {
    const result = await rules(
      "modules/feature",
      'process.env.VALUE = "changed";\ndelete process.env.OLD_VALUE;\nObject.assign(process.env, { NEXT: "value" });\nprocess.chdir("/tmp");\n',
      "feature.test.ts",
    );
    expect(
      result.filter((rule) => rule === "test-process-environment-mutation"),
    ).toHaveLength(3);
    expect(result).toContain("test-process-chdir");
  });

  test("allows explicit environment and root inputs", async () => {
    expect(
      await rules(
        "modules/feature",
        'const environment = { VALUE: "fixture" };\nconst root = "/scoped/root";\nexport const input = { environment, root };\n',
        "feature.test.ts",
      ),
    ).toEqual([]);
  });

  test("rejects console spies and process terminal replacement", async () => {
    const result = await rules(
      "modules/feature",
      'declare function spyOn(target: object, method: string): void;\nspyOn(console, "error");\nconsole.log = () => undefined;\nprocess.stdout.isTTY = true;\nObject.defineProperty(process, "stdin", { value: {} });\n',
      "feature.test.ts",
    );
    expect(
      result.filter((rule) => rule === "test-console-mutation"),
    ).toHaveLength(2);
    expect(
      result.filter((rule) => rule === "test-process-stream-mutation"),
    ).toHaveLength(2);
  });

  test("allows scoped recording logger and terminal fixtures", async () => {
    expect(
      await rules(
        "modules/feature",
        'const messages: string[] = [];\nconst logger = { error: (message: string) => messages.push(message) };\nconst terminal = { stdout: (message: string) => messages.push(message), interactive: true };\nlogger.error("failure");\nterminal.stdout("output");\n',
        "feature.test.ts",
      ),
    ).toEqual([]);
  });

  test("rejects global fake timers and direct global clock mutation", async () => {
    const result = await rules(
      "modules/feature",
      'declare function useFakeTimers(): void;\nuseFakeTimers();\nDate.now = () => 0;\nObject.defineProperty(globalThis, "setTimeout", { value: () => 1 });\n',
      "feature.test.ts",
    );
    expect(result).toContain("test-global-fake-time");
    expect(
      result.filter((rule) => rule === "test-global-clock-mutation"),
    ).toHaveLength(2);
  });

  test("allows an owner-local deterministic clock", async () => {
    expect(
      await rules(
        "modules/feature",
        "const clock = { now: () => 42, advanceBy: (duration: number) => duration };\nclock.advanceBy(5);\nexport const observed = clock.now();\n",
        "feature.test.ts",
      ),
    ).toEqual([]);
  });

  test("rejects global dependency hooks, product mocks, spies, and handler DSLs", async () => {
    const result = await rules(
      "modules/feature",
      'import { productFunction } from "./product.js";\ndeclare function mock(value: unknown): { module(path: string, factory: () => unknown): void };\ndeclare function setLogger(value: unknown): void;\ndeclare function spyOn(target: object, method: string): void;\ndeclare const productService: { run(): void };\ndeclare const external: { mockImplementation(value: () => unknown): void };\nsetLogger({});\nmock.module("./product.js", () => ({}));\nmock(productFunction);\nspyOn(productService, "run");\nexternal.mockImplementation(() => "response");\n',
      "feature.test.ts",
    );
    expect(result).toEqual([
      "test-global-dependency-mutation",
      "test-product-module-mock",
      "test-product-function-mock",
      "test-arbitrary-method-spy",
      "test-external-handler-dsl",
    ]);
  });

  test("allows scoped bindings, pure callbacks, and stateful technical fixtures", async () => {
    expect(
      await rules(
        "modules/feature",
        'import { productFunction } from "./product.js";\ndeclare function mock(callback: () => void): () => void;\nconst fixture = { outcomes: new Map<string, string>(), givenResult(key: string, value: string) { this.outcomes.set(key, value); } };\nconst binding = { logger: { error: (_message: string) => undefined } };\nfixture.givenResult("request", "response");\nmock(() => undefined)();\nproductFunction();\nexport { binding, fixture };\n',
        "feature.test.ts",
      ),
    ).toEqual([]);
  });

  test("enforces the exact owner dependency manifest", async () => {
    const clockFile = "src/platform/clock/clock.ts";
    const validClock = dependencyContracts[clockFile] ?? "";
    const scenarios = [
      {
        source: `${validClock}\nconst secondClockDependency = createDependency<Clock>("second clock");\n`,
        rule: "unauthorized-dependency-contract",
      },
      {
        source: `${validClock}\n{ const clockDependency = createDependency<Clock>("clock"); }\n`,
        rule: "dependency-contract-manifest",
      },
      {
        source: validClock.replace("clockDependency", "renamedClockDependency"),
        rule: "dependency-contract-manifest",
      },
      {
        source: validClock.replace("provideClock", "bindClock"),
        rule: "dependency-contract-manifest",
      },
      {
        source: validClock.replace(
          'const clockDependency = createDependency<Clock>("clock");\n',
          "",
        ),
        rule: "dependency-contract-manifest",
      },
    ];
    for (const scenario of scenarios) {
      const { architecture, root } = await dependencyManifestFixture({
        [clockFile]: scenario.source,
      });
      expect(await scanSideEffects(architecture, root)).toContainEqual(
        expect.objectContaining({ rule: scenario.rule, file: clockFile }),
      );
    }
  });

  test("rejects moved and additional dependency contracts", async () => {
    const clockFile = "src/platform/clock/clock.ts";
    const processFile = "src/platform/process/process-manager.ts";
    const { architecture, root } = await dependencyManifestFixture({
      [clockFile]: (dependencyContracts[clockFile] ?? "").replace(
        'const clockDependency = createDependency<Clock>("clock");\n',
        "",
      ),
      [processFile]: `${dependencyContracts[processFile] ?? ""}\nconst movedClockDependency = createDependency<Clock>("clock");\n`,
    });
    const violations = await scanSideEffects(architecture, root);
    expect(violations).toContainEqual(
      expect.objectContaining({
        rule: "dependency-contract-manifest",
        file: clockFile,
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({
        rule: "unauthorized-dependency-contract",
        file: processFile,
      }),
    );

    expect(
      await rules(
        "modules/feature",
        'import { createDependency as makeDependency } from "#platform/dependency-injection/index.js";\nmakeDependency<string>("eleventh");\n',
      ),
    ).toContain("unauthorized-dependency-contract");
  });

  test("rejects ConfigurationService binding outside its composition point", async () => {
    expect(
      await rules(
        "modules/feature",
        "declare function provideConfigurationService(value: unknown): void;\nprovideConfigurationService({});\n",
      ),
    ).toContain("configuration-provider-composition-only");
  });

  test("allows filesystem access in its owners and the process output adapter", async () => {
    expect(
      await rules(
        "platform/filesystem",
        'export { readFile } from "node:fs/promises";\n',
      ),
    ).toEqual([]);
    expect(
      await rules(
        "platform/process",
        'import { createWriteStream } from "node:fs";\nexport function createNodeProcessAdapter() { return createWriteStream("child.log"); }\n',
        "node-process-adapter.ts",
      ),
    ).toEqual([]);
  });
});
