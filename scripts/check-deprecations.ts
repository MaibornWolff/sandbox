import "core-js/stable/disposable-stack/index.js";
import "core-js/stable/async-disposable-stack/index.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import ts from "typescript-api";
import { getRepoRootPath } from "#platform/git/index.js";

export interface DeprecationViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

interface TypeScriptProject {
  readonly configPath: string;
  readonly config: ts.ParsedCommandLine;
}

function loadProjects(
  configPath: string,
  projects = new Map<string, TypeScriptProject>(),
): readonly TypeScriptProject[] {
  if (projects.has(configPath)) return [...projects.values()];
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (config.errors.length) {
    throw new Error(
      config.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n"),
    );
  }
  projects.set(configPath, { configPath, config });
  for (const reference of config.projectReferences ?? []) {
    loadProjects(ts.resolveProjectReferencePath(reference), projects);
  }
  return [...projects.values()];
}

function createProjectService(project: TypeScriptProject): ts.LanguageService {
  const snapshots = new Map<string, ts.IScriptSnapshot>();
  function getScriptSnapshot(filename: string): ts.IScriptSnapshot | undefined {
    const cached = snapshots.get(filename);
    if (cached) return cached;
    const text = ts.sys.readFile(filename);
    if (text === undefined) return undefined;
    const snapshot = ts.ScriptSnapshot.fromString(text);
    snapshots.set(filename, snapshot);
    return snapshot;
  }

  return ts.createLanguageService({
    ...ts.sys,
    getCompilationSettings: () => project.config.options,
    getScriptFileNames: () => project.config.fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot,
    getCurrentDirectory: () => path.dirname(project.configPath),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  });
}

function deprecationViolation(
  rootDirectory: string,
  diagnostic: ts.Diagnostic,
): DeprecationViolation {
  if (!diagnostic.file || diagnostic.start === undefined) {
    throw new Error(
      "TypeScript reported a deprecation without a source location",
    );
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return {
    file: path
      .relative(rootDirectory, diagnostic.file.fileName)
      .replaceAll("\\", "/"),
    line: position.line + 1,
    column: position.character + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
}

export function checkDeprecations(
  rootDirectory: string,
  verbose = false,
): {
  readonly exitCode: number;
  readonly violations: readonly DeprecationViolation[];
} {
  const violations = new Map<string, DeprecationViolation>();
  for (const project of loadProjects(
    path.join(rootDirectory, "tsconfig.json"),
  )) {
    if (!project.config.fileNames.length) continue;
    if (verbose) {
      console.error(
        `Checking deprecations in ${chalk.dim(project.configPath)}`,
      );
    }
    const service = createProjectService(project);
    using _cleanup = { [Symbol.dispose]: () => service.dispose() };
    for (const filename of project.config.fileNames) {
      for (const diagnostic of service.getSuggestionDiagnostics(filename)) {
        if (!diagnostic.reportsDeprecated) continue;
        const violation = deprecationViolation(rootDirectory, diagnostic);
        const key = `${violation.file}:${violation.line}:${violation.column}:${violation.message}`;
        violations.set(key, violation);
      }
    }
  }
  return {
    exitCode: violations.size ? 1 : 0,
    violations: [...violations.values()],
  };
}

async function main(): Promise<void> {
  const rootDirectory = await getRepoRootPath(process.cwd());
  console.error(`Checking deprecated APIs in ${chalk.dim(rootDirectory)}`);
  const result = checkDeprecations(
    rootDirectory,
    process.argv.includes("--verbose"),
  );
  for (const violation of result.violations) {
    const location = `${violation.file}:${violation.line}:${violation.column}`;
    console.error(
      `${chalk.dim(location)}: ${chalk.bold("Deprecated API")}: ${violation.message}`,
    );
  }
  if (!result.exitCode) console.log("Deprecation check passed");
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
