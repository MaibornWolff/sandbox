import * as path from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  pathExists as hostPathExists,
  isExecutableFile,
} from "#platform/filesystem/index.js";

export interface ExecutableDetector {
  readonly kind: "executable";
  readonly executable: string;
}

export interface PathDetector {
  readonly kind: "path";
  readonly path: string;
}

export interface CapabilityDetectionDeclarations {
  readonly duringUserInit: readonly (ExecutableDetector | PathDetector)[];
  readonly duringProjectInit: readonly PathDetector[];
}

type PathApi = typeof path.posix;

interface DetectableCapability {
  readonly detect?: CapabilityDetectionDeclarations;
}

interface UserDetectionEnvironment {
  readonly homeDirectory: string;
  readonly pathApi: PathApi;
  readonly executableExists: (executable: string) => Promise<boolean>;
  readonly pathExists: (candidatePath: string) => boolean;
}

interface ProjectDetectionEnvironment {
  readonly pathApi: PathApi;
  readonly pathExists: (candidatePath: string) => boolean;
}

export function hasExecutable(executable: string): ExecutableDetector {
  return { kind: "executable", executable };
}

export function hasPath(detectorPath: string): PathDetector {
  return { kind: "path", path: detectorPath };
}

/** @testonly */
export function resolveUserDetectorPath(
  detectorPath: string,
  homeDirectory: string,
  pathApi: PathApi,
): string {
  if (detectorPath.startsWith("~/")) {
    return pathApi.resolve(homeDirectory, detectorPath.slice(2));
  }
  if (pathApi.isAbsolute(detectorPath)) return pathApi.normalize(detectorPath);
  throw new Error(
    `User detector path must start with "~/" or be absolute: ${detectorPath}`,
  );
}

/** @testonly */
export function resolveProjectDetectorPath(
  detectorPath: string,
  projectRoot: string,
  pathApi: PathApi,
): string {
  if (pathApi.isAbsolute(detectorPath)) {
    throw new Error(
      `Project detector path must not be absolute: ${detectorPath}`,
    );
  }
  if (!detectorPath.startsWith("./")) {
    throw new Error(
      `Project detector path must start with "./": ${detectorPath}`,
    );
  }

  const normalizedRoot = pathApi.resolve(projectRoot);
  const resolvedPath = pathApi.resolve(normalizedRoot, detectorPath.slice(2));
  const relativePath = pathApi.relative(normalizedRoot, resolvedPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativePath)
  ) {
    throw new Error(
      `Project detector path must stay inside the project root: ${detectorPath}`,
    );
  }
  return resolvedPath;
}

function getWindowsExecutableNames(
  executable: string,
  variables: Readonly<Record<string, string>>,
): string[] {
  if (path.win32.extname(executable)) return [executable];
  const extensions = (variables.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return extensions.map((extension) => `${executable}${extension}`);
}

async function executableExistsOnHost(executable: string): Promise<boolean> {
  const environment = getHostEnvironment();
  const pathApi = environment.platform === "win32" ? path.win32 : path.posix;
  const executableNames =
    environment.platform === "win32"
      ? getWindowsExecutableNames(executable, environment.variables)
      : [executable];
  const searchDirectories = (environment.variables.PATH ?? "")
    .split(pathApi.delimiter)
    .filter(Boolean);

  return searchDirectories.some((directory) =>
    executableNames.some((name) =>
      isExecutableFile(pathApi.join(directory, name), environment.platform),
    ),
  );
}

function getDefaultUserEnvironment(): UserDetectionEnvironment {
  const environment = getHostEnvironment();
  return {
    homeDirectory: environment.homeDirectory,
    pathApi: environment.platform === "win32" ? path.win32 : path.posix,
    executableExists: executableExistsOnHost,
    pathExists: hostPathExists,
  };
}

function getDefaultProjectEnvironment(): ProjectDetectionEnvironment {
  const environment = getHostEnvironment();
  return {
    pathApi: environment.platform === "win32" ? path.win32 : path.posix,
    pathExists: hostPathExists,
  };
}

async function matchesUserDeclarations(
  declarations: CapabilityDetectionDeclarations["duringUserInit"],
  environment: UserDetectionEnvironment,
): Promise<boolean> {
  const checks = declarations.map((detector) => {
    if (detector.kind === "executable") {
      return environment.executableExists(detector.executable);
    }
    const detectorPath = resolveUserDetectorPath(
      detector.path,
      environment.homeDirectory,
      environment.pathApi,
    );
    return Promise.resolve(environment.pathExists(detectorPath));
  });
  return (await Promise.all(checks)).some(Boolean);
}

/** @lintignore Public capability detection API used by initialization flows. */
export async function detectUserCapabilities<
  Capability extends DetectableCapability,
>(
  tools: readonly Capability[],
  environment: UserDetectionEnvironment = getDefaultUserEnvironment(),
): Promise<Capability[]> {
  const matches = await Promise.all(
    tools.map(async (tool) => ({
      tool,
      matches: await matchesUserDeclarations(
        tool.detect?.duringUserInit ?? [],
        environment,
      ),
    })),
  );
  return matches.filter((match) => match.matches).map((match) => match.tool);
}

function matchesProjectDeclarations(
  declarations: CapabilityDetectionDeclarations["duringProjectInit"],
  projectRoot: string,
  environment: ProjectDetectionEnvironment,
): boolean {
  const resolvedPaths = declarations.map((detector) => {
    if (detector.kind !== "path") {
      throw new Error("Project detector must be a path detector");
    }
    return resolveProjectDetectorPath(
      detector.path,
      projectRoot,
      environment.pathApi,
    );
  });
  return resolvedPaths.some(environment.pathExists);
}

/** @lintignore Public capability detection API used by initialization flows. */
export async function detectProjectCapabilities<
  Capability extends DetectableCapability,
>(
  tools: readonly Capability[],
  resolvedProjectRoot: string,
  environment: ProjectDetectionEnvironment = getDefaultProjectEnvironment(),
): Promise<Capability[]> {
  return tools.filter((tool) =>
    matchesProjectDeclarations(
      tool.detect?.duringProjectInit ?? [],
      resolvedProjectRoot,
      environment,
    ),
  );
}
