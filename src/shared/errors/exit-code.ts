/** Extract a numeric child-process exit code, defaulting to 1. */
export function getErrorExitCode(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  ) {
    return error.exitCode;
  }
  return 1;
}
