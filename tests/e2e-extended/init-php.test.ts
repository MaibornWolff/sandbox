import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupProject, createTempProject } from "../e2e/utils/project.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "../e2e/utils/sandbox.js";

describe.skipIf(process.env.SANDBOX_E2E_EXTENDED !== "1")(
  "PHP tool installation",
  () => {
    let projectDir: string;
    let sb: SandboxInstance;

    beforeAll(async () => {
      projectDir = await createTempProject("php");
      sb = createSandbox({ cwd: projectDir });
      assertSandboxSuccess(
        await sb.exec(["init", "--project", "--tools", "php,composer"], {
          timeoutSeconds: 60,
        }),
      );
      assertSandboxSuccess(await sb.build(300));
    }, 360_000);

    afterAll(async () => {
      await cleanupProject(projectDir, sb);
    });

    test("installs PHP 8.5", async () => {
      const result = await sb.run("php", "--version");
      assertSandboxSuccess(result);
      expect(result.stdout).toMatch(/PHP 8\.5\./);
    });

    test("loads the standard extensions", async () => {
      const result = await sb.run("php", "-m");
      assertSandboxSuccess(result);
      expect(result.stdout).toContain("curl");
      expect(result.stdout).toContain("mbstring");
      expect(result.stdout).toContain("zip");
    });

    test("loads the database, cache, and misc extensions", async () => {
      const result = await sb.run("php", "-m");
      assertSandboxSuccess(result);
      for (const extension of [
        "mysqli",
        "pdo_mysql",
        "pdo_pgsql",
        "redis",
        "apcu",
        "amqp",
        "pcov",
        "soap",
        "imagick",
        "ldap",
      ]) {
        expect(result.stdout).toContain(extension);
      }
    });

    test("installs Xdebug with mode off until XDEBUG_MODE enables it", async () => {
      const script = "echo ini_get('xdebug.mode');";
      const defaultMode = await sb.run("php", "-r", script);
      assertSandboxSuccess(defaultMode);
      expect(defaultMode.stdout.trim()).toBe("off");

      const enabled = await sb.run(
        "sh",
        "-c",
        `XDEBUG_MODE=debug php -r "${script}"`,
      );
      assertSandboxSuccess(enabled);
      expect(enabled.stdout.trim()).toBe("debug");
    });

    test("installs executable Composer", async () => {
      const result = await sb.run("composer", "--version");
      assertSandboxSuccess(result);
      expect(result.stdout).toMatch(/Composer version/);
    });
  },
);
