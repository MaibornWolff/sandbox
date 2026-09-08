import { basename } from "node:path";

export function resolveHostAgentTitle(command: string[]): string | undefined {
  const executable = command[0];

  if (!executable) {
    return undefined;
  }

  return basename(executable);
}
