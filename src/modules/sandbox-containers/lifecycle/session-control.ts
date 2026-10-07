import { getClock, waitWithTimeout } from "#platform/clock/index.js";
import type {
  SandboxExecProcess,
  SandboxInstanceOperations,
} from "#platform/container-runtime/index.js";
import { getSessionControlMarkerDirectory } from "#platform/container-system/index.js";
import { getLogger } from "#platform/logging/index.js";

const CONTROL_READY = "sandbox-session-control-ready";
const OUTPUT_LIMIT = 16_384;

function collectOutput(
  stream: AsyncIterable<Uint8Array>,
  onOutput: (output: string) => void,
): Promise<void> {
  return (async () => {
    let output = "";
    for await (const bytes of stream) {
      output += Buffer.from(bytes).toString("utf8");
      if (output.length > OUTPUT_LIMIT)
        throw new Error("Container session control output exceeded its limit.");
      onOutput(output);
    }
  })();
}

async function awaitSessionControl(
  control: SandboxExecProcess,
  timeoutMs: number,
  resources: AsyncDisposableStack,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const ready = Promise.withResolvers<void>();
  let stdout = "";
  let stderr = "";
  const output = collectOutput(control.stdout, (value) => {
    stdout = value;
    if (value.split("\n").includes(CONTROL_READY)) ready.resolve();
  }).catch((error: unknown) => ready.reject(error));
  const diagnostics = collectOutput(control.stderr, (value) => {
    stderr = value;
  }).catch((error: unknown) => ready.reject(error));
  resources.defer(async () => {
    await Promise.all([output, diagnostics]);
  });
  resources.use(control);
  const startup = await waitWithTimeout(
    Promise.race([
      ready.promise.then(() => 0),
      control.completion.then(async (result) => {
        await Promise.all([output, diagnostics]);
        return result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
      }),
    ]),
    { clock: getClock(), milliseconds: timeoutMs + 1_000 },
  );
  return { exitCode: startup.completed ? startup.value : 124, stdout, stderr };
}

export async function openSessionControl(options: {
  readonly containers: Pick<SandboxInstanceOperations, "openExec">;
  readonly containerId: string;
  readonly attempts: number;
  readonly timeoutMs: number;
  readonly command: readonly string[];
}): Promise<{
  readonly control: AsyncDisposable;
  readonly result: { exitCode: number; stdout: string; stderr: string };
}> {
  await using resources = new AsyncDisposableStack();
  const directory = getSessionControlMarkerDirectory();
  const script =
    `set -eu; mkdir -p "${directory}"; marker="${directory}/$$"; touch "$marker"; ` +
    "trap 'rm -f \"$marker\"' EXIT; " +
    "i=0; while [ ! -f /tmp/.sandbox-ready ]; do " +
    `i=$((i + 1)); [ "$i" -ge ${options.attempts} ] && exit 124; sleep 0.05; done; ` +
    `mkdir -p "${directory}"; touch "$marker"; ` +
    "printf '%s\\n' 'sandbox-session-ready'; " +
    'if [ "$#" -gt 0 ]; then /usr/bin/timeout --signal=KILL 5 "$@"; fi; ' +
    `printf '%s\\n' '${CONTROL_READY}'; read -r _ || true`;
  const control = await options.containers.openExec(options.containerId, {
    command: ["sh", "-c", script, "sandbox-session", ...options.command],
    user: "root",
  });
  const result = await awaitSessionControl(
    control,
    options.timeoutMs,
    resources,
  );
  getLogger().debug(
    `Container session control prepared with exit code ${result.exitCode}`,
  );
  return { control: resources.move(), result };
}
