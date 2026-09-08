import { accessSync, constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

function getExecutableExtensions(): string[] {
  if (process.platform !== "win32") {
    return [""];
  }

  const pathExt = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
}

function canExecute(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatePaths(command: string, directory: string): string[] {
  const extensions = getExecutableExtensions();
  const hasExtension = extensions.some((extension) =>
    command.toLowerCase().endsWith(extension.toLowerCase()),
  );
  const candidates = hasExtension
    ? [command]
    : extensions.map((extension) => `${command}${extension}`);

  return candidates.map((candidate) => join(directory, candidate));
}

export function findExecutable(command: string): string | null {
  if (isAbsolute(command) || dirname(command) !== ".") {
    return canExecute(command) ? command : null;
  }

  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of pathEntries) {
    for (const candidate of candidatePaths(command, directory)) {
      if (canExecute(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
