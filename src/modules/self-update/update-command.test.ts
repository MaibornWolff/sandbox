import { describe, expect, it } from "bun:test";
import { createNpmFixture } from "#platform/npm/__test__/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { updateCommand } from "./update-command.js";

const packageName = "@maibornwolff/sandbox";
const homebrewPackageRoot =
  "/home/linuxbrew/.linuxbrew/Cellar/sandbox/1.0.0/libexec/lib/node_modules/@maibornwolff/sandbox";

describe("update command", () => {
  it("leaves a Homebrew installation to Homebrew", async () => {
    const root = createTestDir("update-homebrew");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    let operations: ReturnType<
      ReturnType<typeof createNpmFixture>["operations"]
    > = [];

    const scope = await runInHostTestScope({ root }, async ({ processes }) => {
      const npm = createNpmFixture(processes);
      npm.givenPackageVersion(packageName, "2.0.0");
      npm.prepare();
      await updateCommand(homebrewPackageRoot);
      operations = npm.operations();
    });

    expect(scope.stderr).toContain("brew upgrade sandbox");
    expect(scope.stdout).toContain("Latest version:   2.0.0");
    expect(operations).toEqual([{ type: "version.lookup", packageName }]);
  });
});
