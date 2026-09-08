export function getProcessArguments(): readonly string[] {
  return process.argv;
}

export function setExitCode(code: number): void {
  process.exitCode = code;
}

export function exitProcess(code: number): never {
  process.exit(code);
}
