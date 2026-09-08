import { randomUUID } from "node:crypto";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { architecture as defaultArchitecture } from "../../architecture.js";
import { type ArchitectureScan, buildRules } from "./build-rules.js";
import {
  type ArchitectureDefinition,
  validateArchitecture,
} from "./define-architecture.js";
import {
  type ImportBoundaryViolation,
  scanImportBoundaries,
} from "./scan-import-boundaries.js";
import {
  type SideEffectViolation,
  scanSideEffects,
} from "./scan-side-effects.js";

interface CruiseViolation {
  readonly rule: { readonly name: string };
  readonly from: string;
  readonly to: string;
  readonly cycle?: readonly { readonly name: string }[];
}

interface CruiseDependency {
  readonly resolved?: string;
  readonly dependencyTypes: readonly string[];
}

interface CruiseModule {
  readonly source: string;
  readonly dependencies: readonly CruiseDependency[];
}

interface CruiseResult {
  readonly modules?: readonly CruiseModule[];
  readonly summary: { readonly violations: readonly CruiseViolation[] };
}

export interface ArchitectureCheckOptions {
  readonly architecture?: ArchitectureDefinition;
  readonly rootDirectory?: string;
  readonly runtimeBinary?: string;
  readonly temporaryDirectory?: string;
}

interface ArchitectureCheckDependencies {
  readonly runCruise?: (options: {
    readonly configPath: string;
    readonly input: string;
    readonly rootDirectory: string;
    readonly scan: ArchitectureScan;
    readonly tsconfig: string;
    readonly runtimeBinary: string;
  }) => Promise<CruiseResult>;
  readonly scan?: typeof scanSideEffects;
  readonly scanImports?: typeof scanImportBoundaries;
}

const GROUPS = ["apps", "modules", "platform", "shared"] as const;
const PERMITTED_TOP_LEVEL_SOURCE_FILES = new Set(["global.d.ts"]);

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function validateDiscoveredComponents(
  definition: ArchitectureDefinition,
  srcDirectory: string,
  group: (typeof GROUPS)[number],
): Promise<void> {
  const groupDirectory = path.join(srcDirectory, group);
  if (!(await isDirectory(groupDirectory))) return;
  const declaredNames = new Set(
    definition[group].map((component) => component.name),
  );
  for (const entry of await readdir(groupDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      throw new Error(`Non-directory entry in src/${group}: ${entry.name}`);
    }
    if (!declaredNames.has(entry.name)) {
      throw new Error(`Undeclared ${group} component directory: ${entry.name}`);
    }
    if (!(await isFile(path.join(groupDirectory, entry.name, "index.ts")))) {
      throw new Error(`Missing facade: src/${group}/${entry.name}/index.ts`);
    }
  }
}

async function validateComponentDirectories(
  definition: ArchitectureDefinition,
  srcDirectory: string,
  group: (typeof GROUPS)[number],
): Promise<void> {
  for (const component of definition[group]) {
    const componentDirectory = path.join(srcDirectory, group, component.name);
    if (!(await isDirectory(componentDirectory))) {
      throw new Error(
        `Missing ${group} component directory: ${component.name}`,
      );
    }
  }
}

async function validateSourceRoots(
  definition: ArchitectureDefinition,
  srcDirectory: string,
): Promise<void> {
  const permittedRoots = new Set([
    ...definition.legacyRoots,
    ...GROUPS,
    "test",
    "node_modules",
  ]);
  for (const entry of await readdir(srcDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && !permittedRoots.has(entry.name)) {
      throw new Error(`Undeclared legacy source root: ${entry.name}`);
    }
    if (
      !entry.isDirectory() &&
      !PERMITTED_TOP_LEVEL_SOURCE_FILES.has(entry.name)
    ) {
      throw new Error(`Undeclared top-level source file: src/${entry.name}`);
    }
  }
}

export async function validateArchitectureDirectories(
  definition: ArchitectureDefinition,
  rootDirectory: string,
): Promise<void> {
  const srcDirectory = path.join(rootDirectory, "src");
  for (const group of GROUPS) {
    await validateDiscoveredComponents(definition, srcDirectory, group);
    await validateComponentDirectories(definition, srcDirectory, group);
    for (const component of definition[group]) {
      for (const assetRoot of component.assets ?? []) {
        if (!(await isDirectory(path.join(rootDirectory, assetRoot)))) {
          throw new Error(
            `Missing asset root owned by ${group}/${component.name}: ${assetRoot}`,
          );
        }
      }
    }
  }
  await validateSourceRoots(definition, srcDirectory);
}

async function runCruiseWithRuntime(options: {
  readonly configPath: string;
  readonly input: string;
  readonly rootDirectory: string;
  readonly scan: ArchitectureScan;
  readonly tsconfig: string;
  readonly runtimeBinary: string;
}): Promise<CruiseResult> {
  const runner = path.join(
    options.rootDirectory,
    "scripts",
    "architecture",
    "run-dependency-cruiser.mjs",
  );
  const process = Bun.spawn(
    [
      options.runtimeBinary,
      runner,
      options.configPath,
      options.input,
      options.tsconfig,
    ],
    {
      cwd: options.rootDirectory,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `dependency-cruiser ${options.scan} scan failed: ${stderr.trim() || stdout.trim() || `exit code ${exitCode}`}`,
    );
  }
  try {
    return JSON.parse(stdout) as CruiseResult;
  } catch {
    throw new Error(
      `dependency-cruiser ${options.scan} scan returned invalid JSON`,
    );
  }
}

function formatCruiseViolation(
  scan: ArchitectureScan,
  violation: CruiseViolation,
): string {
  const cycle = violation.cycle?.map(({ name }) => name).join(" -> ");
  return [
    `[${scan}] ${violation.rule.name}: ${violation.from} -> ${violation.to}`,
    cycle ? `cycle: ${cycle}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatSourceViolation(
  category: "imports" | "side-effects",
  violation: ImportBoundaryViolation | SideEffectViolation,
): string {
  return `[${category}] [${violation.rule}] ${violation.file}:${violation.line} ${violation.detail}`;
}

type ComponentGroup = (typeof GROUPS)[number];

interface ComponentOwner {
  readonly group: ComponentGroup;
  readonly name: string;
}

function getComponentOwner(file: string): ComponentOwner | undefined {
  const match = file.match(/^src\/(apps|modules|platform|shared)\/([^/]+)\//u);
  if (!match?.[1] || !match[2]) return undefined;
  return { group: match[1] as ComponentGroup, name: match[2] };
}

interface CollectedGraph {
  readonly usedDependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly violations: ReadonlySet<string>;
}

function collectModuleGraph(options: {
  readonly module: CruiseModule;
  readonly usedDependencies: Map<string, Set<string>>;
  readonly violations: Set<string>;
}): void {
  const source = getComponentOwner(options.module.source);
  if (!source) return;
  const sourceKey = `${source.group}/${source.name}`;
  const used = options.usedDependencies.get(sourceKey) ?? new Set<string>();
  options.usedDependencies.set(sourceKey, used);

  for (const dependency of options.module.dependencies) {
    if (!dependency.resolved) continue;
    const target = getComponentOwner(dependency.resolved);
    if (!target || target.name === source.name) continue;
    used.add(target.name);
    if (dependency.dependencyTypes.includes("export")) {
      options.violations.add(
        `[re-export] ${sourceKey} re-exports from ${target.group}/${target.name}`,
      );
    }
  }
}

function collectGraph(modules: readonly CruiseModule[]): CollectedGraph {
  const usedDependencies = new Map<string, Set<string>>();
  const violations = new Set<string>();
  for (const module of modules) {
    collectModuleGraph({ module, usedDependencies, violations });
  }
  return { usedDependencies, violations };
}

function findStaleDependencies(
  definition: ArchitectureDefinition,
  usedDependencies: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  return GROUPS.flatMap((group) =>
    definition[group].flatMap((component) => {
      const owner = `${group}/${component.name}`;
      const used = usedDependencies.get(owner) ?? new Set<string>();
      return component.dependencies
        .filter((dependency) => !used.has(dependency))
        .map(
          (dependency) =>
            `[dependencies] ${owner} declares unused dependency ${dependency}`,
        );
    }),
  );
}

function findDeclaredGraphViolations(
  definition: ArchitectureDefinition,
  modules: readonly CruiseModule[],
): string[] {
  const graph = collectGraph(modules);
  return [
    ...graph.violations,
    ...findStaleDependencies(definition, graph.usedDependencies),
  ];
}

export async function runArchitectureCheck(
  options: ArchitectureCheckOptions = {},
  dependencies: ArchitectureCheckDependencies = {},
): Promise<void> {
  const definition = options.architecture ?? defaultArchitecture;
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const runtimeBinary = options.runtimeBinary ?? process.execPath;
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  const runCruise = dependencies.runCruise ?? runCruiseWithRuntime;
  const scan = dependencies.scan ?? scanSideEffects;
  const scanImports = dependencies.scanImports ?? scanImportBoundaries;

  validateArchitecture(definition);
  await validateArchitectureDirectories(definition, rootDirectory);
  const violations: string[] = [];
  for (const scanName of ["production", "test"] as const) {
    const configPath = path.join(
      temporaryDirectory,
      `sandbox-architecture-${scanName}-${randomUUID()}.json`,
    );
    try {
      await writeFile(
        configPath,
        `${JSON.stringify(buildRules(definition, scanName), null, 2)}\n`,
      );
      const result = await runCruise({
        configPath,
        input: "src",
        rootDirectory,
        scan: scanName,
        tsconfig:
          scanName === "production"
            ? "tsconfig.src.json"
            : "tsconfig.test.json",
        runtimeBinary,
      });
      violations.push(
        ...result.summary.violations.map((violation) =>
          formatCruiseViolation(scanName, violation),
        ),
      );
      if (scanName === "production" && result.modules) {
        violations.push(
          ...findDeclaredGraphViolations(definition, result.modules),
        );
      }
    } finally {
      await unlink(configPath).catch(() => undefined);
    }
  }

  const importViolations = await scanImports(rootDirectory);
  violations.push(
    ...importViolations.map((violation) =>
      formatSourceViolation("imports", violation),
    ),
  );
  const sideEffectViolations = await scan(definition, rootDirectory);
  violations.push(
    ...sideEffectViolations.map((violation) =>
      formatSourceViolation("side-effects", violation),
    ),
  );

  if (violations.length > 0) {
    throw new Error(`Architecture violations:\n${violations.join("\n")}`);
  }
}

if (import.meta.main) {
  runArchitectureCheck()
    .then(() => console.log("Architecture check passed"))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
