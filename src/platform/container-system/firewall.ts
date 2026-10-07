import type { ProcessManager, ProcessResult } from "#platform/process/index.js";
import { createCommandError } from "./command.js";

function renderArgument(argument: string): string {
  if (!/^[a-zA-Z0-9_.,:/%!=+@-]+$/u.test(argument)) {
    throw new Error(`Invalid firewall argument: ${JSON.stringify(argument)}`);
  }
  return argument;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function unwrap<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

export async function restoreFirewall(options: {
  readonly processes: ProcessManager;
  readonly command: string;
  readonly commands: readonly (readonly string[])[];
  readonly signal?: AbortSignal;
}): Promise<void> {
  options.signal?.throwIfAborted();
  if (options.commands.length === 0) return;
  const rules = options.commands.map((args) =>
    args.map(renderArgument).join(" "),
  );
  const input = Buffer.from(["*filter", ...rules, "COMMIT", ""].join("\n"));
  await using child = options.processes.start({
    command: options.command,
    args: ["--noflush"],
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "stream",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const sendInput = async () => {
    await child.stdin.write(input);
    await child.stdin.end();
  };
  const sentInput = sendInput().then(
    () => ({ status: "fulfilled" as const, value: undefined }),
    async (reason: unknown) => {
      await child.stop();
      return { status: "rejected" as const, reason };
    },
  );
  const [status, stdout, stderr, sent] = await Promise.all([
    child.result,
    collect(child.stdout),
    collect(child.stderr),
    sentInput,
  ]);
  options.signal?.throwIfAborted();
  const result: ProcessResult = {
    ...status,
    stdout,
    stderr,
  };
  if (result.exitCode !== 0 || result.signal) {
    throw createCommandError(options.command, result);
  }
  unwrap(sent);
}
