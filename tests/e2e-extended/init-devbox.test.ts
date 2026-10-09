import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "../e2e/utils/project.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "../e2e/utils/sandbox.js";

const OFFLINE_FALLBACK_VERSION = "0.8.3";

describe.skipIf(process.env.SANDBOX_E2E_EXTENDED !== "1")(
  "Devbox tool installation",
  () => {
    let projectDir: string;
    let sb: SandboxInstance;

    beforeAll(async () => {
      projectDir = await createTempProject("devbox");
      await writeProjectFile(projectDir, "devbox.json", '{"packages":[]}\n');
      await writeProjectFile(
        projectDir,
        "devbox.lock",
        '{"lockfile_version":"1"}\n',
      );
      sb = createSandbox({ cwd: projectDir });
      assertSandboxSuccess(
        await sb.exec(["init", "--project", "--tools", "devbox"], {
          timeoutSeconds: 60,
        }),
      );
      assertSandboxSuccess(await sb.build(600));
    }, 900_000);

    afterAll(async () => {
      await cleanupProject(projectDir, sb);
    });

    test("finds Nix in a bash login shell", async () => {
      const result = await sb.exec(
        ["run", "--", "bash", "-lc", "command -v nix"],
        { timeoutSeconds: 120 },
      );
      assertSandboxSuccess(result);
      expect(result.stdout).toContain("/nix/");
    }, 150_000);

    test("resolves the Devbox version instead of using the offline fallback", async () => {
      const result = await sb.exec(["run", "--", "devbox", "version"], {
        timeoutSeconds: 120,
      });
      assertSandboxSuccess(result);
      expect(result.stdout.trim()).not.toBe(OFFLINE_FALLBACK_VERSION);
      expect(result.stdout.trim()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
    }, 150_000);
  },
);
