import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  copyPath,
  detectExistingAgentConfigs,
  getExistingTargetPaths,
} from "./agent-config-copying.js";

describe("agent config copying", () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = createTestDir("agent-config-copying");
    home = path.join(root, "home");
  });
  afterEach(() => cleanupTestDir(root));

  function write(relativePath: string, content = "{}"): void {
    const file = path.join(home, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  test("detects multiple configurations from the scoped home", async () => {
    write(".claude/settings.json");
    write(".codex/config.toml", 'model = "gpt-4"');
    const detected = (
      await runInHostTestScope({ root }, () => detectExistingAgentConfigs())
    ).result;
    expect(detected.map((config) => config.name)).toEqual([
      "Claude Code",
      "Codex",
    ]);
  });

  test("copies nested directories while excluding build artifacts", () => {
    write(".config/opencode/opencode.jsonc");
    write(".config/opencode/prompts/default.md", "# Default");
    write(".config/opencode/node_modules/package.js", "module");
    write(".config/opencode/.git/config", "git config");
    const source = path.join(home, ".config", "opencode");
    const target = path.join(root, "target");
    copyPath(source, home, target);
    expect(
      fs.readFileSync(
        path.join(target, ".config", "opencode", "prompts", "default.md"),
        "utf8",
      ),
    ).toBe("# Default");
    expect(
      fs.existsSync(path.join(target, ".config", "opencode", "node_modules")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(target, ".config", "opencode", ".git")),
    ).toBe(false);
  });

  test("reports existing targets under the scoped settings root", async () => {
    write(".claude/settings.json");
    const target = path.join(
      root,
      "config",
      "settings",
      ".claude",
      "settings.json",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}");
    const existing = (
      await runInHostTestScope({ root }, () => {
        const config = detectExistingAgentConfigs()[0];
        if (!config) throw new Error("Expected Claude config");
        return getExistingTargetPaths(config);
      })
    ).result;
    expect(existing).toEqual([".claude/settings.json"]);
  });
});
