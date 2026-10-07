import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import type { SandboxInstance } from "./utils/sandbox.js";
import { assertSandboxSuccess, createSandbox } from "./utils/sandbox.js";

const runAppleE2e = process.env.SANDBOX_E2E_APPLE === "1";

describe.skipIf(!runAppleE2e)(
  "Apple end-user no-build networking with shared runtime state",
  () => {
    let projectDir: string;
    let sb: SandboxInstance;

    beforeAll(async () => {
      projectDir = await createTempProject("apple-networking-no-build");
      await writeProjectFile(
        projectDir,
        ".sandbox/config.toml",
        `runtime = "apple-container"
allow_network = ["example.com"]

[[allow_host_commands]]
pattern = [${JSON.stringify(process.execPath)}, "--version"]
`,
      );
      sb = createSandbox({ cwd: projectDir, timeoutSeconds: 180 });
      assertSandboxSuccess(await sb.build(900));
    }, 1_000_000);

    afterAll(async () => {
      if (sb) await sb.exec(["clean", "--force"], { timeoutSeconds: 120 });
      await cleanupProject(projectDir, sb);
    });

    test("maps only exact host aliases with the configured DNS mode", async () => {
      const result = await sb.exec([
        "--no-build",
        "run",
        "--",
        "node",
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
import { resolve4 } from "node:dns/promises";
for (const host of ["host.container.internal", "host.docker.internal"]) {
  const addresses = await resolve4(host);
  assert.ok(addresses.length > 0);
  const subdomain = await resolve4("child." + host).catch((error) => {
    if (error.code === "ENOTFOUND" || error.code === "ENODATA") return [];
    throw error;
  });
  assert.ok(subdomain.every((address) => !addresses.includes(address)));
}`,
      ]);
      assertSandboxSuccess(result);
    });

    test("supports no-build without changing shared Apple builder state", async () => {
      const result = await sb.exec(
        [
          "--no-build",
          "run",
          "--",
          "sh",
          "-c",
          `set -eu
getent hosts host.container.internal >/dev/null
getent hosts host.docker.internal >/dev/null
getent ahostsv4 example.com >/dev/null
sandbox escape ${JSON.stringify(process.execPath)} --version >/dev/null`,
        ],
        { timeoutSeconds: 180 },
      );

      assertSandboxSuccess(result);
    });
  },
);
