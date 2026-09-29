/** Return whether a thrown value is a filesystem or spawn error for a missing path (`ENOENT`). */
export function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
