/** Return the message of an `Error`, or the string form of any other thrown value. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
