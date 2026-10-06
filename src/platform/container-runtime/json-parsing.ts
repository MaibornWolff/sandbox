export function parseRuntimeJsonArray<T>(
  output: string,
  invalidJsonMessage: string,
  invalidDataMessage: string,
): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(invalidJsonMessage, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(invalidDataMessage);
  return parsed as T[];
}
