import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript-api";
import type { ArchitectureDefinition } from "./define-architecture.js";

const FORBIDDEN_IMPORTS = new Map([
  ["node:console", "console"],
  ["console", "console"],
  ["node:process", "process global"],
  ["process", "process global"],
  ["node:timers", "time"],
  ["node:timers/promises", "time"],
  ["timers", "time"],
  ["timers/promises", "time"],
  ["node:perf_hooks", "time"],
  ["node:fs", "filesystem"],
  ["node:fs/promises", "filesystem"],
  ["fs", "filesystem"],
  ["fs/promises", "filesystem"],
  ["node:child_process", "process"],
  ["child_process", "process"],
  ["node:http", "network I/O"],
  ["node:https", "network I/O"],
  ["node:net", "network I/O"],
  ["node:tls", "network I/O"],
  ["node:dgram", "network I/O"],
  ["node:dns", "network I/O"],
  ["node:dns/promises", "network I/O"],
]);

const APPROVED_IMPORT_FILES: Readonly<Record<string, readonly RegExp[]>> = {
  console: [],
  "process global": [
    /^src\/platform\/environment\/(?:host-environment|sandbox-environment|system)\.ts$/u,
    /^src\/platform\/terminal\/terminal\.ts$/u,
  ],
  time: [/^src\/platform\/clock\/clock\.ts$/u],
  filesystem: [
    /^src\/platform\/filesystem\//u,
    /^src\/platform\/process\/node-process-adapter\.ts$/u,
    /^src\/platform\/container-system\/(?:container-lifecycle|diagnostics|network-bootstrap|network-files)\.ts$/u,
  ],
  process: [/^src\/platform\/process\/node-process-adapter\.ts$/u],
  "network I/O": [
    /^src\/platform\/container-system\/(?:dns|tcp-service)\.ts$/u,
    /^src\/platform\/websocket\/node-websocket-service\.ts$/u,
  ],
};

const PROCESS_FACTORY_FILES = new Map<string, ReadonlySet<string>>([
  [
    "src/platform/process/node-process-adapter.ts",
    new Set(["createNodeProcessAdapter", "linuxStartTime", "probePid"]),
  ],
  [
    "src/platform/environment/host-environment.ts",
    new Set(["readProcessEnvironment"]),
  ],
  [
    "src/platform/environment/sandbox-environment.ts",
    new Set(["readSandboxProcessEnvironment"]),
  ],
  [
    "src/platform/environment/system.ts",
    new Set(["getProcessArguments", "setExitCode", "exitProcess"]),
  ],
  [
    "src/platform/terminal/terminal.ts",
    new Set(["createProcessTerminal", "readProcessTerminalStreams"]),
  ],
]);

const TIMER_FACTORY_FILES = new Map<string, ReadonlySet<string>>([
  ["src/platform/clock/clock.ts", new Set(["createSystemClock"])],
  [
    "src/platform/container-system/tcp-service.ts",
    new Set(["createNodeTcpService"]),
  ],
]);

const SOCKET_FACTORY_FILES = new Map<string, ReadonlySet<string>>([
  [
    "src/platform/container-system/tcp-service.ts",
    new Set(["createNodeTcpService"]),
  ],
  [
    "src/platform/websocket/node-websocket-service.ts",
    new Set(["connect", "createNodeWebSocketService"]),
  ],
]);

interface DependencyContractManifestEntry {
  readonly file: string;
  readonly variable: string;
  readonly type: string;
  readonly token: string;
  readonly provider: string;
  readonly getter: string;
}

const DEPENDENCY_CONTRACT_MANIFEST: readonly DependencyContractManifestEntry[] =
  [
    {
      file: "src/modules/configuration/configuration-service.ts",
      variable: "configurationServiceDependency",
      type: "ConfigurationService",
      token: "configuration service",
      provider: "provideConfigurationService",
      getter: "getConfigurationService",
    },
    {
      file: "src/platform/clock/clock.ts",
      variable: "clockDependency",
      type: "Clock",
      token: "clock",
      provider: "provideClock",
      getter: "getClock",
    },
    {
      file: "src/platform/container-runtime/runtime-provider.ts",
      variable: "runtimeProviderDependency",
      type: "ContainerRuntimeProvider",
      token: "container runtime provider",
      provider: "provideRuntimeProvider",
      getter: "getRuntimeProvider",
    },
    {
      file: "src/platform/container-system/tcp-service.ts",
      variable: "tcpServiceDependency",
      type: "TcpService",
      token: "TCP service",
      provider: "provideTcpService",
      getter: "getTcpService",
    },
    {
      file: "src/platform/environment/host-environment.ts",
      variable: "hostEnvironmentDependency",
      type: "HostEnvironmentExecution",
      token: "host environment",
      provider: "provideHostEnvironment",
      getter: "getHostEnvironment",
    },
    {
      file: "src/platform/environment/sandbox-environment.ts",
      variable: "sandboxEnvironmentDependency",
      type: "SandboxEnvironment",
      token: "sandbox environment",
      provider: "provideSandboxEnvironment",
      getter: "getSandboxEnvironment",
    },
    {
      file: "src/platform/logging/logger.ts",
      variable: "loggerDependency",
      type: "Logger",
      token: "logger",
      provider: "provideLogger",
      getter: "getLogger",
    },
    {
      file: "src/platform/process/process-manager.ts",
      variable: "processManagerDependency",
      type: "ProcessManager",
      token: "process manager",
      provider: "provideProcessManager",
      getter: "getProcessManager",
    },
    {
      file: "src/platform/terminal/terminal.ts",
      variable: "terminalDependency",
      type: "Terminal",
      token: "terminal",
      provider: "provideTerminal",
      getter: "getTerminal",
    },
    {
      file: "src/platform/websocket/websocket-service.ts",
      variable: "webSocketServiceDependency",
      type: "WebSocketService",
      token: "WebSocket service",
      provider: "provideWebSocketService",
      getter: "getWebSocketService",
    },
  ];

const APPROVED_COLLABORATOR_CONTRACTS = new Map<string, ReadonlySet<string>>([
  [
    "src/modules/configuration/configuration-service.ts",
    new Set(["ConfigurationService"]),
  ],
  ["src/platform/clock/clock.ts", new Set(["Clock"])],
  [
    "src/platform/container-runtime/runtime-provider.ts",
    new Set(["ContainerRuntimeProvider"]),
  ],
  [
    "src/platform/container-system/network-bootstrap.ts",
    new Set(["ContainerNetworkSystem"]),
  ],
  ["src/platform/container-system/tcp-service.ts", new Set(["TcpService"])],
  [
    "src/platform/environment/host-environment.ts",
    new Set(["HostEnvironmentExecution"]),
  ],
  ["src/platform/logging/logger.ts", new Set(["Logger"])],
  ["src/platform/process/process-manager.ts", new Set(["ProcessManager"])],
  [
    "src/platform/websocket/websocket-service.ts",
    new Set(["WebSocketService"]),
  ],
]);

const APPROVED_OPERATION_CALLBACKS = new Set([
  "beforeSpawn",
  "buildArgs",
  "buildLaunchSpec",
  "getPath",
  "getTemplate",
  "onAbort",
  "onChild",
  "operation",
  "wasAborted",
]);
const TECHNICAL_FUNCTION_ROLES =
  /^(?:applyFirewall|debug|discoverUpstreamDns|ensureDirectory|execute|readFile|runCommand|spawn|spawnNetworkCommand|startDnsmasq|startNetworkTrace|startSquid|stderr|stdout|touchFiles|writeFile|setOwnership)$/u;
const LEGACY_GLOBAL_HOOKS = new Set([
  "configureLogger",
  "resetDependencies",
  "resetLogger",
  "resetTerminal",
  "setDependencies",
  "setLogger",
  "setTerminal",
]);
const RUNTIME_CONSTRUCTORS = new Set([
  "createRuntimeService",
  "DockerService",
  "PodmanService",
  "resolveRuntime",
]);
const MUTABLE_CACHE_NAME = /(?:cache|dependencies|registry)$/iu;
const TEST_GLOBAL_HOOKS = new Set([
  ...LEGACY_GLOBAL_HOOKS,
  "disableLogging",
  "enableLogging",
  "overrideDependency",
  "registerDependency",
  "setLogLevel",
  "setSilent",
  "setVerbose",
]);
const TEST_FAKE_TIME_CALLS = new Set([
  "advanceTimersByTime",
  "advanceTimersToNextTimer",
  "runAllTimers",
  "runOnlyPendingTimers",
  "setSystemTime",
  "useFakeTimers",
  "useRealTimers",
]);
const TEST_HANDLER_DSL_METHODS = new Set([
  "callsFake",
  "mockImplementation",
  "mockImplementationOnce",
  "mockRejectedValue",
  "mockRejectedValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
  "onCall",
]);
const PROCESS_STREAMS = new Set(["stdin", "stdout", "stderr"]);
const TEST_REPLACEMENT_CALLS = new Set([
  "assign",
  "defineProperty",
  "deleteProperty",
  "set",
]);
const GLOBAL_CLOCK_MEMBERS = new Set([
  "Date",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
]);

export interface SideEffectViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
      if (entry.isFile() && entry.name.endsWith(".ts")) return [entryPath];
      return [];
    }),
  );
  return files.flat();
}

async function collectTypeScriptFilesIfPresent(
  directory: string,
): Promise<string[]> {
  try {
    return await collectTypeScriptFiles(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function isTestModule(file: string): boolean {
  return (
    file.endsWith(".test.ts") || file.includes(`${path.sep}__test__${path.sep}`)
  );
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function getImportedComponentOwner(
  relativeFile: string,
  imported: string,
): string | undefined {
  if (!imported.startsWith(".")) return undefined;
  const normalizedFile = relativeFile.replaceAll("\\", "/");
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalizedFile), imported),
  );
  const match = resolved.match(
    /^src\/(apps|modules|platform|shared)\/([^/]+)\//u,
  );
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : undefined;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return (
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isInsideApprovedFactory(
  node: ts.Node,
  relativeFile: string,
  factories: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const approved = factories.get(relativeFile);
  if (!approved) return false;
  let current = node.parent;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name &&
      approved.has(current.name.getText())
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function findCrossComponentReExport(options: {
  readonly node: ts.Node;
  readonly sourceFile: ts.SourceFile;
  readonly relativeFile: string;
  readonly owner: string;
}): SideEffectViolation | undefined {
  if (
    !ts.isExportDeclaration(options.node) ||
    !options.node.moduleSpecifier ||
    !ts.isStringLiteral(options.node.moduleSpecifier)
  ) {
    return undefined;
  }
  const targetOwner = getImportedComponentOwner(
    options.relativeFile,
    options.node.moduleSpecifier.text,
  );
  if (!targetOwner || targetOwner === options.owner) return undefined;
  return {
    file: options.relativeFile,
    line: lineOf(options.sourceFile, options.node),
    rule: "cross-component-re-export",
    detail: `${options.owner} cannot re-export from ${targetOwner}`,
  };
}

function typeLooksLikeCollaborator(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isFunctionTypeNode(type)) return true;
  return /(?:Service|Provider|Executor|Factory|Client|Adapter|Logger|Terminal|Clock|Runtime|Process)(?:\b|>)/u.test(
    type.getText(),
  );
}

function initializerLooksLikeCollaborator(
  parameterName: string,
  initializer: ts.Expression | undefined,
): boolean {
  if (!initializer) return false;
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return true;
  }
  const collaboratorName =
    /(?:service|provider|executor|factory|client|adapter|logger|terminal|clock|runtime|process|handler|callback|exec|spawn|resolve)/iu.test(
      parameterName,
    );
  return (
    collaboratorName &&
    (ts.isIdentifier(initializer) ||
      ts.isPropertyAccessExpression(initializer) ||
      ts.isCallExpression(initializer))
  );
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function isOperationCallback(name: string): boolean {
  return APPROVED_OPERATION_CALLBACKS.has(name) || /^on[A-Z]/u.test(name);
}

function isCollaboratorMember(member: ts.TypeElement): boolean {
  if (!ts.isPropertySignature(member)) return false;
  const name = propertyName(member.name);
  if (!name || isOperationCallback(name)) return false;
  if (member.type !== undefined && ts.isFunctionTypeNode(member.type)) {
    return TECHNICAL_FUNCTION_ROLES.test(name);
  }
  if (typeLooksLikeCollaborator(member.type)) {
    return !(name === "runtime" && member.type?.getText() === "Runtime");
  }
  return false;
}

interface DependencyDeclaration {
  readonly file: string;
  readonly line: number;
  readonly variable?: string;
  readonly type?: string;
  readonly token?: string;
  readonly privateConst: boolean;
  readonly sourceFile: ts.SourceFile;
}

function declarationName(node: ts.VariableDeclaration): string | undefined {
  return ts.isIdentifier(node.name) ? node.name.text : undefined;
}

class ProductionFileScanner {
  readonly #violations: SideEffectViolation[] = [];
  readonly #dependencyFactoryImports = new Set<string>();
  readonly #relativeFile: string;

  constructor(
    readonly sourceFile: ts.SourceFile,
    relativeFile: string,
    readonly owner: string,
    readonly dependencyDeclarations: DependencyDeclaration[],
  ) {
    this.#relativeFile = relativeFile.replaceAll("\\", "/");
  }

  scan(): SideEffectViolation[] {
    for (const statement of this.sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        this.collectDependencyFactoryImport(statement);
      }
    }
    this.visit(this.sourceFile);
    return this.#violations;
  }

  private add(node: ts.Node, rule: string, detail: string): void {
    this.#violations.push({
      file: this.#relativeFile,
      line: lineOf(this.sourceFile, node),
      rule,
      detail,
    });
  }

  private collectDependencyFactoryImport(node: ts.ImportDeclaration): void {
    if (
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "#platform/dependency-injection/index.js"
    ) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "createDependency") {
        this.#dependencyFactoryImports.add(element.name.text);
      }
    }
  }

  private inspectImport(node: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const imported = node.moduleSpecifier.text;
    const capability = FORBIDDEN_IMPORTS.get(imported);
    if (isTypeOnlyImport(node) && capability !== "process") return;
    if (!capability) return;
    const approved = APPROVED_IMPORT_FILES[capability]?.some((pattern) =>
      pattern.test(this.#relativeFile),
    );
    if (approved) return;
    this.add(
      node,
      `direct-${capability.replaceAll(" ", "-")}-import`,
      `Import ${imported} in its approved production adapter file`,
    );
  }

  private inspectDependencyBag(
    node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  ): void {
    if (
      APPROVED_COLLABORATOR_CONTRACTS.get(this.#relativeFile)?.has(
        node.name.text,
      )
    ) {
      return;
    }
    const members = ts.isInterfaceDeclaration(node)
      ? node.members
      : ts.isTypeLiteralNode(node.type)
        ? node.type.members
        : [];
    if (!members.some(isCollaboratorMember)) return;
    this.add(
      node,
      "collaborator-dependency-bag",
      `${node.name.text} cannot aggregate technical collaborators`,
    );
  }

  private inspectParameter(node: ts.ParameterDeclaration): void {
    const parameterName = node.name.getText();
    if (isOperationCallback(parameterName)) {
      return;
    }
    if (!node.questionToken && !node.initializer) return;
    if (
      !typeLooksLikeCollaborator(node.type) &&
      !initializerLooksLikeCollaborator(parameterName, node.initializer)
    ) {
      return;
    }
    this.add(
      node,
      "optional-collaborator-default",
      "Optional service and function parameters must not provide collaborator defaults",
    );
  }

  private inspectDependencyCall(node: ts.CallExpression, called: string): void {
    if (this.#dependencyFactoryImports.has(called)) {
      const declaration = ts.isVariableDeclaration(node.parent)
        ? node.parent
        : undefined;
      const statement = declaration?.parent.parent;
      const privateConst =
        statement !== undefined &&
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        !statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );
      const tokenArgument = node.arguments[0];
      this.dependencyDeclarations.push({
        file: this.#relativeFile,
        line: lineOf(this.sourceFile, node),
        variable: declaration ? declarationName(declaration) : undefined,
        type: node.typeArguments?.[0]?.getText(this.sourceFile),
        token:
          tokenArgument && ts.isStringLiteral(tokenArgument)
            ? tokenArgument.text
            : undefined,
        privateConst,
        sourceFile: this.sourceFile,
      });
      if (
        !DEPENDENCY_CONTRACT_MANIFEST.some(
          ({ file }) => file === this.#relativeFile,
        )
      ) {
        this.add(
          node,
          "unauthorized-dependency-contract",
          "Scoped dependency contracts are limited to the exact ten-token manifest",
        );
      }
    }
    if (
      called === "provideConfigurationService" &&
      this.#relativeFile !== "src/apps/sandbox/application.ts"
    ) {
      this.add(
        node,
        "configuration-provider-composition-only",
        "Only the sandbox application may bind ConfigurationService",
      );
    }
  }

  private inspectRuntimeCall(node: ts.CallExpression, called: string): void {
    if (
      RUNTIME_CONSTRUCTORS.has(called) &&
      this.owner !== "platform/container-runtime"
    ) {
      this.add(
        node,
        "container-runtime-construction-owner-only",
        "Construct container runtimes inside the container-runtime owner",
      );
    }
    if (
      called === "createProductionRuntimeProvider" &&
      this.owner !== "platform/container-runtime" &&
      this.#relativeFile !== "src/apps/sandbox/production-application.ts"
    ) {
      this.add(
        node,
        "runtime-provider-composition-only",
        "Construct the runtime provider only in its owner or host composition",
      );
    }
  }

  private inspectLegacyAndTimerCall(
    node: ts.CallExpression,
    called: string,
  ): void {
    if (LEGACY_GLOBAL_HOOKS.has(called)) {
      this.add(
        node,
        "legacy-global-dependency-hook",
        `${called} is a forbidden global dependency hook`,
      );
    }
    const timer =
      called === "setTimeout" ||
      called === "setInterval" ||
      called === "clearTimeout" ||
      called === "clearInterval";
    if (
      timer &&
      !isInsideApprovedFactory(node, this.#relativeFile, TIMER_FACTORY_FILES)
    ) {
      this.add(node, "direct-timer", "Use the scoped Clock owner");
    }
  }

  private inspectCall(node: ts.CallExpression): void {
    if (ts.isPropertyAccessExpression(node.expression)) {
      const called = node.expression.name.text;
      if (
        new Set([
          "isRunning",
          "kill",
          "sendSignal",
          "subscribeToSignals",
          "unref",
        ]).has(called) &&
        !this.#relativeFile.startsWith("src/platform/process/")
      ) {
        this.add(
          node,
          "raw-process-control-owner-only",
          `${called} is owned by platform/process`,
        );
      }
      return;
    }
    if (!ts.isIdentifier(node.expression)) return;
    const called = node.expression.text;
    this.inspectDependencyCall(node, called);
    this.inspectRuntimeCall(node, called);
    this.inspectLegacyAndTimerCall(node, called);
    if (called === "fetch") {
      this.add(
        node,
        "direct-fetch",
        "Call fetch through an approved platform API",
      );
    }
  }

  private inspectConsole(node: ts.Node): void {
    if (!ts.isPropertyAccessExpression(node)) return;
    const expression = node.expression.getText(this.sourceFile);
    if (expression !== "console" && expression !== "globalThis.console") {
      return;
    }
    this.add(node, "direct-console", "Write through scoped Logger or Terminal");
  }

  private inspectProcess(node: ts.Node): void {
    const directIdentifier =
      ts.isIdentifier(node) &&
      node.text === "process" &&
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node;
    const globalAccess =
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(this.sourceFile) === "globalThis" &&
      node.name.text === "process";
    if (!directIdentifier && !globalAccess) return;
    if (
      isInsideApprovedFactory(node, this.#relativeFile, PROCESS_FACTORY_FILES)
    ) {
      return;
    }
    this.add(
      node,
      "direct-process-global",
      "Access process only inside an approved process snapshot or adapter factory",
    );
  }

  private inspectClock(node: ts.Node): void {
    const dateNow =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Date" &&
      node.expression.name.text === "now";
    const currentDate =
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments?.length ?? 0) === 0;
    if (!dateNow && !currentDate) return;
    if (
      isInsideApprovedFactory(node, this.#relativeFile, TIMER_FACTORY_FILES)
    ) {
      return;
    }
    this.add(node, "direct-clock", "Read time through the scoped Clock owner");
  }

  private inspectSocket(node: ts.Node): void {
    if (
      !ts.isNewExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !/^(?:Socket|WebSocket)$/u.test(node.expression.text)
    ) {
      return;
    }
    if (
      isInsideApprovedFactory(node, this.#relativeFile, SOCKET_FACTORY_FILES)
    ) {
      return;
    }
    this.add(
      node,
      "direct-socket",
      "Create sockets in the approved network adapter",
    );
  }

  private inspectRuntimeConstruction(node: ts.Node): void {
    if (
      !ts.isNewExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !/^(?:DockerService|PodmanService)$/u.test(node.expression.text) ||
      this.owner === "platform/container-runtime"
    ) {
      return;
    }
    this.add(
      node,
      "container-runtime-construction-owner-only",
      "Construct container runtimes inside the container-runtime owner",
    );
  }

  private inspectModuleState(node: ts.Node): void {
    if (!ts.isVariableStatement(node) || !ts.isSourceFile(node.parent)) return;
    const mutableKeyword =
      (node.declarationList.flags & ts.NodeFlags.Const) === 0;
    for (const declaration of node.declarationList.declarations) {
      this.inspectModuleDeclaration(declaration, mutableKeyword);
    }
  }

  private inspectModuleDeclaration(
    declaration: ts.VariableDeclaration,
    mutableKeyword: boolean,
  ): void {
    const name = declarationName(declaration);
    const initializer = declaration.initializer;
    const mutableCollection =
      initializer !== undefined &&
      ts.isNewExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      /^(?:Map|Set|WeakMap|WeakSet)$/u.test(initializer.expression.text) &&
      name !== undefined &&
      MUTABLE_CACHE_NAME.test(name);
    if (!mutableKeyword && !mutableCollection) return;
    if (
      this.#relativeFile ===
      "src/platform/dependency-injection/dependency-scope.ts"
    ) {
      return;
    }
    this.add(
      declaration,
      "mutable-module-dependency-state",
      "Module-level mutable caches and dependency registries are forbidden",
    );
  }

  private visit = (node: ts.Node): void => {
    const reExport = findCrossComponentReExport({
      node,
      sourceFile: this.sourceFile,
      relativeFile: this.#relativeFile,
      owner: this.owner,
    });
    if (reExport) this.#violations.push(reExport);
    if (ts.isImportDeclaration(node)) this.inspectImport(node);
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      this.inspectDependencyBag(node);
    }
    if (ts.isParameter(node)) this.inspectParameter(node);
    if (ts.isCallExpression(node)) this.inspectCall(node);
    this.inspectConsole(node);
    this.inspectProcess(node);
    this.inspectClock(node);
    this.inspectSocket(node);
    this.inspectRuntimeConstruction(node);
    this.inspectModuleState(node);
    ts.forEachChild(node, this.visit);
  };
}

function accessedPath(node: ts.Expression): readonly string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) {
    const base = accessedPath(node.expression);
    return base ? [...base, node.name.text] : undefined;
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNumericLiteral(node.argumentExpression))
  ) {
    const base = accessedPath(node.expression);
    return base ? [...base, node.argumentExpression.text] : undefined;
  }
  return undefined;
}

function normalizeGlobalPath(parts: readonly string[]): readonly string[] {
  return parts[0] === "globalThis" ? parts.slice(1) : parts;
}

function assignmentTarget(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return node.left;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }
  if (ts.isDeleteExpression(node)) return node.expression;
  return undefined;
}

function callName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text;
  }
  return undefined;
}

function isProductImport(specifier: string): boolean {
  return (
    specifier.startsWith("#apps/") ||
    specifier.startsWith("#modules/") ||
    specifier.startsWith("#platform/") ||
    specifier.startsWith("#shared/") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

type TestMutationKind = "environment" | "stream" | "console" | "clock";

const TEST_MUTATION_RULES: Readonly<
  Record<TestMutationKind, { readonly rule: string; readonly detail: string }>
> = {
  environment: {
    rule: "test-process-environment-mutation",
    detail:
      "Pass environment values explicitly through a scoped fixture or pure input",
  },
  stream: {
    rule: "test-process-stream-mutation",
    detail:
      "Use a scoped Terminal fixture instead of replacing process streams or TTY state",
  },
  console: {
    rule: "test-console-mutation",
    detail: "Use a scoped recording Logger or Terminal fixture",
  },
  clock: {
    rule: "test-global-clock-mutation",
    detail: "Use the scoped deterministic Clock fixture",
  },
};

function classifyTestMutation(
  parts: readonly string[],
  propertyName?: string,
): TestMutationKind | undefined {
  const normalized = normalizeGlobalPath(parts);
  const processProperty = normalized[1] ?? propertyName;
  if (normalized[0] === "process" && processProperty === "env") {
    return "environment";
  }
  if (
    normalized[0] === "process" &&
    processProperty !== undefined &&
    PROCESS_STREAMS.has(processProperty)
  ) {
    return "stream";
  }
  if (normalized[0] === "console") return "console";
  if (
    normalized[0] === "Date" ||
    (normalized.length === 0 &&
      propertyName !== undefined &&
      GLOBAL_CLOCK_MEMBERS.has(propertyName)) ||
    (normalized.length === 1 &&
      normalized[0] !== undefined &&
      GLOBAL_CLOCK_MEMBERS.has(normalized[0]))
  ) {
    return "clock";
  }
  return undefined;
}

class TestFileScanner {
  readonly #violations: SideEffectViolation[] = [];
  readonly #productImports = new Set<string>();
  readonly #productNamespaces = new Set<string>();
  readonly #relativeFile: string;

  constructor(
    readonly sourceFile: ts.SourceFile,
    relativeFile: string,
  ) {
    this.#relativeFile = relativeFile.replaceAll("\\", "/");
  }

  scan(): SideEffectViolation[] {
    for (const statement of this.sourceFile.statements) {
      if (ts.isImportDeclaration(statement))
        this.collectProductImports(statement);
    }
    this.visit(this.sourceFile);
    return this.#violations;
  }

  private add(node: ts.Node, rule: string, detail: string): void {
    this.#violations.push({
      file: this.#relativeFile,
      line: lineOf(this.sourceFile, node),
      rule,
      detail,
    });
  }

  private collectProductImports(node: ts.ImportDeclaration): void {
    if (
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !isProductImport(node.moduleSpecifier.text) ||
      !node.importClause
    ) {
      return;
    }
    if (node.importClause.name)
      this.#productImports.add(node.importClause.name.text);
    const bindings = node.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      this.#productImports.add(bindings.name.text);
      this.#productNamespaces.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        this.#productImports.add(element.name.text);
      }
    }
  }

  private addMutation(node: ts.Node, kind: TestMutationKind): void {
    const violation = TEST_MUTATION_RULES[kind];
    this.add(node, violation.rule, violation.detail);
  }

  private inspectMutation(node: ts.Node): void {
    const target = assignmentTarget(node);
    if (!target) return;
    const parts = accessedPath(target);
    if (!parts) return;
    const normalized = normalizeGlobalPath(parts);
    if (
      normalized[0] !== undefined &&
      this.#productNamespaces.has(normalized[0]) &&
      normalized.length > 1
    ) {
      this.add(
        node,
        "test-product-module-mock",
        "Use real product modules over scoped technical fixtures",
      );
      return;
    }
    const kind = classifyTestMutation(parts);
    if (kind) this.addMutation(node, kind);
  }

  private inspectPropertyReplacement(node: ts.CallExpression): void {
    const called = callName(node);
    if (!called || !TEST_REPLACEMENT_CALLS.has(called)) return;
    const target = node.arguments[0];
    if (!target) return;
    const property = node.arguments[1];
    const propertyName =
      property &&
      (ts.isStringLiteral(property) || ts.isNumericLiteral(property))
        ? property.text
        : undefined;
    const kind = classifyTestMutation(accessedPath(target) ?? [], propertyName);
    if (kind) this.addMutation(node, kind);
  }

  private inspectSpy(node: ts.CallExpression, called?: string): void {
    if (called !== "spyOn") return;
    const target = node.arguments[0];
    const kind = target
      ? classifyTestMutation(accessedPath(target) ?? [])
      : undefined;
    if (kind) {
      this.addMutation(node, kind);
      return;
    }
    this.add(
      node,
      "test-arbitrary-method-spy",
      "Use real product behavior with owner-local or generic technical fixture state",
    );
  }

  private inspectGlobalCall(
    node: ts.CallExpression,
    called: string | undefined,
    expressionPath: readonly string[],
  ): void {
    if (called === "chdir" && expressionPath[0] === "process") {
      this.add(
        node,
        "test-process-chdir",
        "Use explicit temporary roots instead of changing global CWD",
      );
    }
    if (called && TEST_FAKE_TIME_CALLS.has(called)) {
      this.add(
        node,
        "test-global-fake-time",
        "Use the scoped deterministic Clock fixture",
      );
    }
    if (
      called &&
      TEST_GLOBAL_HOOKS.has(called) &&
      (ts.isIdentifier(node.expression) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          accessedPath(node.expression.expression)?.join(".") === "globalThis"))
    ) {
      this.add(
        node,
        "test-global-dependency-mutation",
        "Bind dependencies inside an execution scope",
      );
    }
  }

  private inspectMock(
    node: ts.CallExpression,
    called: string | undefined,
    expressionPath: readonly string[],
  ): void {
    if (called === "module" && expressionPath[0] === "mock") {
      this.add(
        node,
        "test-product-module-mock",
        "Use real product modules over scoped technical fixtures",
      );
    }
    const mocked = node.arguments[0];
    if (
      called === "mock" &&
      mocked &&
      ts.isIdentifier(mocked) &&
      this.#productImports.has(mocked.text)
    ) {
      this.add(
        node,
        "test-product-function-mock",
        "Use real product functions over explicit inputs or scoped technical fixtures",
      );
    }
    if (called && TEST_HANDLER_DSL_METHODS.has(called)) {
      this.add(
        node,
        "test-external-handler-dsl",
        "Model durable external state and outcomes in an owner-local or generic technical fixture",
      );
    }
  }

  private inspectCall(node: ts.CallExpression): void {
    const called = callName(node);
    const expressionPath = ts.isPropertyAccessExpression(node.expression)
      ? normalizeGlobalPath(accessedPath(node.expression.expression) ?? [])
      : [];
    this.inspectSpy(node, called);
    this.inspectGlobalCall(node, called, expressionPath);
    this.inspectMock(node, called, expressionPath);
    this.inspectPropertyReplacement(node);
  }

  private visit = (node: ts.Node): void => {
    this.inspectMutation(node);
    if (ts.isCallExpression(node)) this.inspectCall(node);
    ts.forEachChild(node, this.visit);
  };
}

function scanProductionFile(
  sourceFile: ts.SourceFile,
  relativeFile: string,
  owner: string,
  dependencyDeclarations: DependencyDeclaration[],
): SideEffectViolation[] {
  return new ProductionFileScanner(
    sourceFile,
    relativeFile,
    owner,
    dependencyDeclarations,
  ).scan();
}

function hasExportedDependencyAccessor(
  sourceFile: ts.SourceFile,
  name: string,
  dependency: string,
  member: "provide" | "get",
): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) === true &&
      statement.body
        ?.getText(sourceFile)
        .includes(`${dependency}.${member}(`) === true,
  );
}

function hasCompleteDependencyManifestArchitecture(
  architecture: ArchitectureDefinition,
): boolean {
  const modules = new Set(architecture.modules.map(({ name }) => name));
  const platform = new Set(architecture.platform.map(({ name }) => name));
  return (
    modules.has("configuration") &&
    [
      "clock",
      "container-runtime",
      "container-system",
      "environment",
      "logging",
      "process",
      "terminal",
    ].every((owner) => platform.has(owner))
  );
}

function inspectDependencyManifest(
  declarations: readonly DependencyDeclaration[],
): SideEffectViolation[] {
  const violations: SideEffectViolation[] = [];
  for (const expected of DEPENDENCY_CONTRACT_MANIFEST) {
    const inFile = declarations.filter(({ file }) => file === expected.file);
    const exact = inFile.filter(
      (declaration) =>
        declaration.variable === expected.variable &&
        declaration.type === expected.type &&
        declaration.token === expected.token &&
        declaration.privateConst &&
        hasExportedDependencyAccessor(
          declaration.sourceFile,
          expected.provider,
          expected.variable,
          "provide",
        ) &&
        hasExportedDependencyAccessor(
          declaration.sourceFile,
          expected.getter,
          expected.variable,
          "get",
        ),
    );
    if (exact.length !== 1) {
      violations.push({
        file: expected.file,
        line: inFile[0]?.line ?? 1,
        rule: "dependency-contract-manifest",
        detail: `Expected exactly one private ${expected.variable}: createDependency<${expected.type}>(${JSON.stringify(expected.token)}) with exported ${expected.provider}() and ${expected.getter}() accessors`,
      });
    }
    for (const declaration of inFile.filter(
      (candidate) => !exact.includes(candidate) || exact.length > 1,
    )) {
      violations.push({
        file: declaration.file,
        line: declaration.line,
        rule: "unauthorized-dependency-contract",
        detail:
          "Dependency declaration does not match the exact ten-token manifest",
      });
    }
  }
  return violations;
}

function scanTestFile(
  sourceFile: ts.SourceFile,
  relativeFile: string,
): SideEffectViolation[] {
  return new TestFileScanner(sourceFile, relativeFile).scan();
}

export async function scanSideEffects(
  architecture: ArchitectureDefinition,
  rootDirectory: string,
): Promise<SideEffectViolation[]> {
  const groups = ["apps", "modules", "platform", "shared"] as const;
  const violations: SideEffectViolation[] = [];
  const dependencyDeclarations: DependencyDeclaration[] = [];

  for (const group of groups) {
    for (const component of architecture[group]) {
      const owner = `${group}/${component.name}`;
      const directory = path.join(rootDirectory, "src", owner);
      const files = await collectTypeScriptFiles(directory);
      for (const file of files.filter(
        (candidate) => !isTestModule(candidate),
      )) {
        const relativeFile = path.relative(rootDirectory, file);
        const content = await readFile(file, "utf8");
        const sourceFile = ts.createSourceFile(
          file,
          content,
          ts.ScriptTarget.Latest,
          true,
        );
        violations.push(
          ...scanProductionFile(
            sourceFile,
            relativeFile,
            owner,
            dependencyDeclarations,
          ),
        );
      }
    }
  }

  if (hasCompleteDependencyManifestArchitecture(architecture)) {
    violations.push(...inspectDependencyManifest(dependencyDeclarations));
  }

  const testFiles = (
    await Promise.all(
      ["src", "scripts", "tests"].map((directory) =>
        collectTypeScriptFilesIfPresent(path.join(rootDirectory, directory)),
      ),
    )
  )
    .flat()
    .filter(isTestModule);
  for (const file of testFiles) {
    const content = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    violations.push(
      ...scanTestFile(sourceFile, path.relative(rootDirectory, file)),
    );
  }

  return violations;
}
