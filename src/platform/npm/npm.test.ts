import { describe, expect, it } from "bun:test";
import { ExecError } from "#platform/process/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createNpmFixture } from "./__test__/index.js";
import {
  fetchLatestVersion,
  runGlobalPackageBinary,
  updateGlobalPackage,
} from "./npm.js";

async function inScope(
  callback: (fixture: ReturnType<typeof createNpmFixture>) => Promise<void>,
): Promise<void> {
  const root = createTestDir("npm-test");
  try {
    await runInHostTestScope({ root }, async ({ processes }) => {
      await callback(createNpmFixture(processes));
    });
  } finally {
    cleanupTestDir(root);
  }
}

describe("npm facade", () => {
  it("looks up and trims package versions through the scoped process service", async () => {
    await inScope(async (npm) => {
      npm.givenPackageVersion("@maibornwolff/sandbox", "1.5.0");
      npm.prepare();
      expect(await fetchLatestVersion("@maibornwolff/sandbox")).toBe("1.5.0");
      expect(npm.operations()).toEqual([
        { type: "version.lookup", packageName: "@maibornwolff/sandbox" },
      ]);
    });
  });

  it("classifies registry authentication and network failures", async () => {
    await inScope(async (npm) => {
      npm.failRegistry("private", "npm ERR! code E401\nUnauthorized");
      npm.prepare();
      const result = fetchLatestVersion("private");
      await expect(result).rejects.toThrow(
        "Failed to check for updates\n" +
          "  npm ERR! code E401\n" +
          "  Check your network connection and configured npm registry.",
      );
      await result.catch((error: unknown) => {
        expect(error).toBeInstanceOf(ExecError);
        expect((error as ExecError).exitCode).toBe(1);
      });
      npm.failRegistry("public", "npm ERR! code ENETUNREACH");
      npm.prepare();
      await expect(fetchLatestVersion("public")).rejects.toThrow(
        "Failed to check for updates",
      );
    });
  });

  it("runs global binaries and records successful package updates", async () => {
    await inScope(async (npm) => {
      npm.givenPackageVersion("@maibornwolff/sandbox", "2.0.0");
      npm.givenInstalledVersion("@maibornwolff/sandbox", "1.0.0");
      npm.givenGlobalBinary("sandbox");
      npm.prepare();
      await runGlobalPackageBinary("sandbox", ["config", "update"]);
      await updateGlobalPackage("@maibornwolff/sandbox");
      expect(npm.installedVersion("@maibornwolff/sandbox")).toBe("2.0.0");
      expect(npm.operations()).toEqual([
        {
          type: "binary.run",
          binaryName: "sandbox",
          args: ["config", "update"],
        },
        { type: "package.update", packageName: "@maibornwolff/sandbox" },
      ]);
    });
  });

  it("preserves binary exit details and isolates parallel process scopes", async () => {
    await Promise.all([
      inScope(async (npm) => {
        npm.givenPackageVersion("first-package", "1.0.0");
        npm.givenGlobalBinary("first-binary", {
          exitCode: 17,
          stderr: "first binary failed",
        });
        npm.prepare();

        expect(await fetchLatestVersion("first-package")).toBe("1.0.0");
        const error = await runGlobalPackageBinary("first-binary", [
          "config",
          "update",
        ]).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(ExecError);
        expect((error as ExecError).exitCode).toBe(17);
        expect((error as ExecError).stderr).toBe("first binary failed");
        expect(npm.operations()).toEqual([
          { type: "version.lookup", packageName: "first-package" },
          {
            type: "binary.run",
            binaryName: "first-binary",
            args: ["config", "update"],
          },
        ]);
      }),
      inScope(async (npm) => {
        npm.givenPackageVersion("second-package", "2.0.0");
        npm.givenGlobalBinary("second-binary");
        npm.prepare();

        expect(await fetchLatestVersion("second-package")).toBe("2.0.0");
        await runGlobalPackageBinary("second-binary", ["config", "update"]);
        expect(npm.operations()).toEqual([
          { type: "version.lookup", packageName: "second-package" },
          {
            type: "binary.run",
            binaryName: "second-binary",
            args: ["config", "update"],
          },
        ]);
      }),
    ]);
  });

  it("reports npm global installation permission guidance", async () => {
    await inScope(async (npm) => {
      npm.failUpdate("@maibornwolff/sandbox");
      npm.prepare();
      const result = updateGlobalPackage("@maibornwolff/sandbox");
      await expect(result).rejects.toThrow(
        "Update failed (permission denied)\n" +
          "  npm cannot update the global package because of insufficient permissions. " +
          "Fix npm global installation permissions or use a Node.js version manager, then retry the update.",
      );
      await result.catch((error: unknown) => {
        expect(error).toBeInstanceOf(ExecError);
        expect((error as ExecError).exitCode).toBe(1);
      });
    });
  });
});
