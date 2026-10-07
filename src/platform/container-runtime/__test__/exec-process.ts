import type { SandboxExecProcess } from "../container-contract.js";

export function createRuntimeExecProcess(options: {
  readonly result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly keepOpen?: boolean;
  readonly onDispose?: () => void;
}): SandboxExecProcess {
  const completion = Promise.withResolvers<{ exitCode: number }>();
  if (!options.keepOpen)
    completion.resolve({ exitCode: options.result.exitCode });
  const stream = async function* (value: string): AsyncIterable<Uint8Array> {
    if (value) yield Buffer.from(value);
    await completion.promise;
  };
  return {
    stdout: stream(options.result.stdout),
    stderr: stream(options.result.stderr),
    completion: completion.promise,
    async [Symbol.asyncDispose]() {
      options.onDispose?.();
      completion.resolve({ exitCode: options.result.exitCode });
      await completion.promise;
    },
  };
}
