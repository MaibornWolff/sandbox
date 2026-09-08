import { createRedactionContext } from "#shared/text/index.js";
import type { RuntimeExecOptions, RuntimeExecutor } from "../executor.js";

export interface RuntimeCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RuntimeCommandEvent extends RuntimeCommand {
  readonly options?: RuntimeExecOptions;
}

export interface StatefulRuntimeCommandExecutor {
  readonly executor: RuntimeExecutor;
  givenOutput(command: RuntimeCommand, output: string): void;
  givenFailure(command: RuntimeCommand, error: Error): void;
  events(): readonly RuntimeCommandEvent[];
}

type RuntimeCommandOutcome =
  | { readonly output: string }
  | { readonly error: Error };

function commandKey(command: string, args: readonly string[]): string {
  return JSON.stringify([command, args]);
}

function cloneOptions(
  options: RuntimeExecOptions | undefined,
): RuntimeExecOptions | undefined {
  if (!options) return undefined;
  return {
    ...options,
    ...(options.env ? { env: { ...options.env } } : {}),
  };
}

export function createStatefulRuntimeCommandExecutor(): StatefulRuntimeCommandExecutor {
  const outcomes = new Map<string, RuntimeCommandOutcome>();
  const recordedEvents: RuntimeCommandEvent[] = [];

  return {
    executor: async (command, args, options) => {
      const normalizedArgs = [...(args ?? [])];
      recordedEvents.push({
        command,
        args: normalizedArgs,
        ...(options ? { options: cloneOptions(options) } : {}),
      });
      const outcome = outcomes.get(commandKey(command, normalizedArgs));
      if (!outcome) {
        const diagnostic = `Unexpected runtime command: executable=${JSON.stringify(command)}, args=${JSON.stringify(normalizedArgs)}, stdio=${options?.interactive ? "inherit" : "capture"}, options=${JSON.stringify(options ?? {})}.`;
        const redaction = createRedactionContext({
          args: normalizedArgs,
          ...(options?.env ? { env: { ...options.env } } : {}),
        });
        throw new Error(redaction.redactText(diagnostic));
      }
      if ("error" in outcome) throw outcome.error;
      return outcome.output;
    },
    givenOutput: ({ command, args }, output) => {
      outcomes.set(commandKey(command, args), { output });
    },
    givenFailure: ({ command, args }, error) => {
      outcomes.set(commandKey(command, args), { error });
    },
    events: () =>
      recordedEvents.map((event) => ({
        ...event,
        args: [...event.args],
        ...(event.options ? { options: cloneOptions(event.options) } : {}),
      })),
  };
}
