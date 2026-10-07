import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import type { SandboxInstance } from "./utils/sandbox.js";
import { assertSandboxSuccess, createSandbox } from "./utils/sandbox.js";

const runHostDnsE2e = process.env.SANDBOX_E2E_APPLE_HOST === "1";

describe.skipIf(!runHostDnsE2e)("Apple primary host DNS", () => {
  let projectDir: string;
  let sb: SandboxInstance;

  beforeAll(async () => {
    projectDir = await createTempProject("apple-host-dns");
    sb = createSandbox({ cwd: projectDir, timeoutSeconds: 180 });
  });

  afterAll(async () => {
    if (sb) await sb.exec(["clean", "--force"], { timeoutSeconds: 120 });
    await cleanupProject(projectDir, sb);
  });

  test("installs just and fetches the mise key through restricted guest DNS", async () => {
    assertSandboxSuccess(
      await sb.exec(["init", "--project", "--tools", "just"], {
        timeoutSeconds: 60,
      }),
    );
    await writeProjectFile(
      projectDir,
      ".sandbox/config.toml",
      `runtime = "apple-container"
allow_network = ["mise.jdx.dev"]

[runtimes.apple-container]
dns = "host"
`,
    );
    assertSandboxSuccess(await sb.build(900));
    const just = await sb.run("just", "--version");
    assertSandboxSuccess(just);
    expect(just.stdout).toMatch(/just \d+\.\d+\.\d+/u);
    const result = await sb.run(
      "sh",
      "-c",
      "set -eu; getent ahostsv4 mise.jdx.dev >/dev/null; curl -fsS --max-time 20 https://mise.jdx.dev/gpg-key.pub; ! nc -z -w 2 1.1.1.1 53",
    );
    assertSandboxSuccess(result);
    expect(result.stdout).toContain("BEGIN PGP PUBLIC KEY BLOCK");
  }, 1_000_000);
});
