import type {
  SandboxExecProcess,
  SandboxInstanceOperations,
} from "#platform/container-runtime/index.js";
import {
  CONTAINER_READY_FILE,
  CONTAINER_START_FAILED_FILE,
  CONTAINER_START_PHASE_FILE,
  getSessionControlMarkerDirectory,
} from "#platform/container-system/index.js";
import { getLogger } from "#platform/logging/index.js";
import { createControlWatchdog, readControlLines } from "./control-watchdog.js";

const CONTROL_READY = "sandbox-session-control-ready";
const START_HOOK_PULSE = "sandbox-start-hooks-running";
const OUTPUT_LIMIT = 16_384;
export const CONTAINER_START_FAILED = 78;

async function awaitSessionControl(
  control: SandboxExecProcess,
  timeoutMs: number,
  resources: AsyncDisposableStack,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const ready = Promise.withResolvers<void>();
  let stdout = "";
  let stderr = "";
  const output = readControlLines(control.stdout, (line) => {
    if (line === START_HOOK_PULSE) {
      watchdog.pulse();
      return;
    }
    stdout += `${line}\n`;
    if (stdout.length > OUTPUT_LIMIT)
      throw new Error("Container session control output exceeded its limit.");
    if (line === "sandbox-session-ready") watchdog.pulse(6_000);
    if (line === CONTROL_READY) ready.resolve();
  }).catch((error: unknown) => ready.reject(error));
  const diagnostics = readControlLines(control.stderr, (line) => {
    stderr += `${line}\n`;
    if (stderr.length > OUTPUT_LIMIT)
      throw new Error("Container session control output exceeded its limit.");
  }).catch((error: unknown) => ready.reject(error));
  resources.defer(async () => {
    await Promise.all([output, diagnostics]);
  });
  resources.use(control);
  using watchdog = createControlWatchdog(timeoutMs + 1_000, signal);
  const exitCode = await Promise.race([
    ready.promise.then(() => 0),
    control.completion.then(async (result) => {
      await Promise.all([output, diagnostics]);
      return result.exitCode === 0 ? 1 : result.exitCode;
    }),
    watchdog.expired.then(() => 124),
  ]);
  return { exitCode, stdout, stderr };
}

export async function openSessionControl(options: {
  readonly containers: Pick<SandboxInstanceOperations, "openExec">;
  readonly containerId: string;
  readonly attempts: number;
  readonly timeoutMs: number;
  readonly command: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<{
  readonly control: AsyncDisposable;
  readonly result: { exitCode: number; stdout: string; stderr: string };
}> {
  await using resources = new AsyncDisposableStack();
  options.signal?.throwIfAborted();
  const directory = getSessionControlMarkerDirectory();
  const script = `
set -eu
mkdir -p "${directory}"
marker="${directory}/$$"
touch "$marker"
trap 'rm -f "$marker"' EXIT
i=0
next_pulse=0
while [ ! -f '${CONTAINER_READY_FILE}' ]; do
  [ ! -f '${CONTAINER_START_FAILED_FILE}' ] || exit ${CONTAINER_START_FAILED}
  if [ -f '${CONTAINER_START_PHASE_FILE}' ]; then
    if [ "$SECONDS" -ge "$next_pulse" ]; then
      printf '%s\\n' '${START_HOOK_PULSE}'
      next_pulse=$((SECONDS + 1))
    fi
  else
    i=$((i + 1))
    [ "$i" -lt ${options.attempts} ] || exit 124
  fi
  if read -r -t 0.05 _; then continue; else [ "$?" -gt 128 ] || exit 1; fi
done
mkdir -p "${directory}"
touch "$marker"
printf '%s\\n' 'sandbox-session-ready'
if [ "$#" -gt 0 ]; then /usr/bin/timeout --signal=KILL 5 "$@"; fi
printf '%s\\n' '${CONTROL_READY}'
read -r _ || true`;
  // Privileged mode skips BASH_ENV and other user-controlled shell startup settings.
  const control = await options.containers.openExec(options.containerId, {
    command: [
      "/bin/bash",
      "-p",
      "-c",
      script,
      "sandbox-session",
      ...options.command,
    ],
    user: "root",
  });
  const result = await awaitSessionControl(
    control,
    options.timeoutMs,
    resources,
    options.signal,
  );
  getLogger().debug(
    `Container session control prepared with exit code ${result.exitCode}`,
  );
  return { control: resources.move(), result };
}
