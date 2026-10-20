import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe.skipIf(process.env.SANDBOX_E2E_EXTENDED !== "1")(
  "long-running host command escape",
  () => {
    let projectDir: string;
    let fixturePath: string;
    let completionPath: string;
    let sb: SandboxInstance;

    beforeAll(async () => {
      projectDir = await createTempProject("host-command-escape-duration");
      fixturePath = join(projectDir, "host-command-fixture.mjs");
      completionPath = join(projectDir, "delayed-host-effect.txt");
      await writeProjectFile(
        projectDir,
        "host-command-fixture.mjs",
        `import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setTimeout(() => {
    writeFileSync(process.argv[2], "completed");
    process.stdout.write("completed after quiet delay\\n");
  }, 8000);
}
`,
      );
      await writeProjectFile(
        projectDir,
        ".sandbox/config.toml",
        `[[allow_host_commands]]
pattern = ${JSON.stringify([process.execPath, fixturePath, completionPath])}
`,
      );
      await writeProjectFile(
        projectDir,
        ".sandbox/docker/Dockerfile",
        "FROM sandbox-base:latest\nENV SANDBOX_IDLE_TIMEOUT_SECONDS=30\n",
      );
      sb = createSandbox({ cwd: projectDir, timeoutSeconds: 40 });
      assertSandboxSuccess(await sb.build());
    }, 360_000);

    afterAll(async () => {
      await cleanupProject(projectDir, sb);
    });

    test("completes a quiet host command after eight seconds", async () => {
      const completed = await sb.run(
        "sandbox",
        "escape",
        "--",
        process.execPath,
        fixturePath,
        completionPath,
      );

      assertSandboxSuccess(completed);
      expect(completed.stdout).toContain("completed after quiet delay");
      expect(readFileSync(completionPath, "utf8")).toBe("completed");
    }, 60_000);
  },
);
