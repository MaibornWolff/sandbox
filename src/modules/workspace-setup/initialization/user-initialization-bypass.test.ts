import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createBypassOnlyConfigs } from "./agent-configuration-flow.js";
import { ensureSettingsGitignore } from "./settings-gitignore.js";

describe("bypass-only initialization", () => {
  let root: string;
  beforeEach(() => {
    root = createTestDir("init-bypass");
  });
  afterEach(() => cleanupTestDir(root));

  it("creates supported bypass configs and skips copied agents", async () => {
    const results = (
      await runInHostTestScope({ root }, () =>
        createBypassOnlyConfigs(new Set(["Claude Code"]), new Set()),
      )
    ).result;
    expect(
      results.find((result) => result.name === "Claude Code"),
    ).toBeUndefined();
    expect(results.find((result) => result.name === "Codex")?.success).toBe(
      true,
    );
    expect(
      results.find((result) => result.name === "OpenCode"),
    ).toBeUndefined();
    expect(
      fs.readFileSync(
        path.join(root, "config", "settings", ".codex", "config.toml"),
        "utf8",
      ),
    ).toContain('sandbox_mode = "danger-full-access"');
  });

  it("writes credential exclusions under the scoped settings root", async () => {
    await runInHostTestScope({ root }, ensureSettingsGitignore);
    const content = fs.readFileSync(
      path.join(root, "config", "settings", ".gitignore"),
      "utf8",
    );
    expect(content).toContain("credentials.json");
    expect(content).toContain("auth.json");
  });
});
