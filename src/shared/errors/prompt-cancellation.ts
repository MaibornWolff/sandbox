/** Return whether an interactive prompt was cancelled by the user. */
export function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "PromptCancellationError";
}
