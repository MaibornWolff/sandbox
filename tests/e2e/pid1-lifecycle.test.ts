import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

function hostname(output: string): string {
  const value = output.trim().split("\n").at(-1);
  if (!value)
    throw new Error(`Missing container hostname in output: ${output}`);
  return value;
}

async function waitForStatus(
  predicate: (output: string) => boolean,
  failureMessage: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let latestStatus:
    | { exitCode: number; stdout: string; stderr: string }
    | undefined;
  while (Date.now() < deadline) {
    const status = await sb.exec(["status"]);
    latestStatus = status;
    if (status.exitCode === 0 && predicate(status.stdout)) return;
    await Bun.sleep(250);
  }
  throw new Error(
    `${failureMessage}\nLatest sandbox status (exit code ${latestStatus?.exitCode ?? "unavailable"}):\nstdout:\n${latestStatus?.stdout ?? ""}\nstderr:\n${latestStatus?.stderr ?? ""}`,
  );
}

async function waitForNoActiveContainers(): Promise<void> {
  await waitForStatus(
    (output) => output.includes("No active containers"),
    "Timed out waiting for the idle container to stop",
  );
}

beforeAll(async () => {
  projectDir = await createTempProject("pid1-lifecycle");
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    "FROM sandbox-base:latest\nENV SANDBOX_IDLE_TIMEOUT_SECONDS=2\n",
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 45 });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("container PID 1 lifecycle", () => {
  test("tracks concurrent and short sessions until final idle shutdown", async () => {
    const longSession = sb.start([
      "run",
      "--",
      "sh",
      "-c",
      "touch /tmp/pid1-session-marker; printf 'session-active\\n'; hostname; sleep 4",
    ]);
    await longSession.waitForOutput("session-active");

    const shortSession = await sb.run(
      "sh",
      "-c",
      "test -f /tmp/pid1-session-marker && hostname",
    );
    const longResult = await longSession.result;
    expect(shortSession.exitCode).toBe(0);
    expect(longResult.exitCode).toBe(0);
    expect(hostname(shortSession.stdout)).toBe(hostname(longResult.stdout));

    await waitForNoActiveContainers();
    const afterIdle = await sb.run(
      "sh",
      "-c",
      "test ! -e /tmp/pid1-session-marker",
    );
    expect(afterIdle.exitCode).toBe(0);
  }, 120_000);

  test("reaps an orphaned child after its session exits", async () => {
    const spawned = await sb.run(
      "sh",
      "-c",
      'sleep 0.2 & echo $! > "$1"',
      "sandbox-orphan-test",
      "/tmp/sandbox-orphan.pid",
    );
    expect(spawned.exitCode).toBe(0);

    const reaped = await sb.run(
      "sh",
      "-c",
      'sleep 1; pid="$(cat "$1")"; test ! -e "/proc/$pid"',
      "sandbox-orphan-test",
      "/tmp/sandbox-orphan.pid",
    );
    expect(reaped.exitCode).toBe(0);
  });

  test("forwards sandbox stop to an active container session", async () => {
    const session = sb.run("sleep", "30");
    await waitForStatus(
      (output) => output.includes("sleep 30"),
      "Timed out waiting for the active sleep session",
    );
    const stopped = await sb.stop();
    const sessionResult = await session;

    expect(stopped.exitCode).toBe(0);
    expect(sessionResult.exitCode).toBe(143);
    expect(sessionResult.stderr).not.toContain("suppressed during disposal");
  }, 60_000);
});
