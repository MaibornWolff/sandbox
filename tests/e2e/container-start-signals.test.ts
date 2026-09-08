import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("container-start-signals");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    'env = ["SANDBOX_DEBUG=1"]\n',
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 120 });

  const built = await sb.build();
  expect(built.exitCode).toBe(0);
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("foreground container start signals", () => {
  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "returns %s with exit code %i after the container entrypoint is ready",
    async (signal, exitCode) => {
      const command = sb.start(["--no-build", "container", "start"]);
      await command.waitForOutput("[container-tools] ready", 60);

      command.sendSignal(signal);

      const result = await command.result;
      if (result.exitCode !== exitCode) {
        throw new Error(
          `Expected exit code ${exitCode} after ${signal}, received ${result.exitCode}.\nstdout:\n${result.rawStdout}\nstderr:\n${result.rawStderr}`,
        );
      }
      expect(result.rawStderr).toContain("[container-tools] syncing settings");

      const status = await sb.exec(["status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("No active containers");
    },
    120_000,
  );
});
