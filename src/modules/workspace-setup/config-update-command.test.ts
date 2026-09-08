import { describe, expect, it } from "bun:test";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { configUpdateCommand } from "./config-update-command.js";

async function runMissingConfig(project: boolean): Promise<string> {
  const root = createTestDir("config-update");
  try {
    const execution = await runInHostTestScope({ root }, () =>
      configUpdateCommand(project ? { project: true } : {}),
    );
    return execution.stdout;
  } finally {
    cleanupTestDir(root);
  }
}

describe("configUpdateCommand", () => {
  it("guides users to initialize missing user configuration", async () => {
    const output = await runMissingConfig(false);
    expect(output).toContain("No existing configuration found.");
    expect(output).toContain("Run sandbox init first.");
  });

  it("guides users to initialize missing project configuration", async () => {
    const output = await runMissingConfig(true);
    expect(output).toContain("Run sandbox init --project first.");
  });
});
