import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  applyBypassSettings,
  createMinimalBypassConfig,
} from "./agent-config-bypass.js";
import { getAgentConfigDefs } from "./agent-config-catalog.js";
import {
  copyPath,
  detectExistingAgentConfigs,
} from "./agent-config-copying.js";

describe("agent config bypass", () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = createTestDir("agent-config-bypass");
    home = path.join(root, "home");
  });
  afterEach(() => cleanupTestDir(root));

  function definition(name: string) {
    const result = getAgentConfigDefs().find((entry) => entry.name === name);
    if (!result) throw new Error(`Missing ${name}`);
    return result;
  }

  test("merges bypass settings into copied Claude and Codex configs", async () => {
    const claudeSource = path.join(home, ".claude", "settings.json");
    const codexSource = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(claudeSource), { recursive: true });
    fs.mkdirSync(path.dirname(codexSource), { recursive: true });
    fs.writeFileSync(claudeSource, '{"existingSetting":true}');
    fs.writeFileSync(codexSource, 'model = "gpt-4"');

    await runInHostTestScope({ root }, () => {
      const detected = detectExistingAgentConfigs();
      for (const config of detected) {
        for (const source of config.sourcePaths) {
          copyPath(source, home, config.targetBaseDir);
        }
        expect(applyBypassSettings(config)).toBe(true);
      }
    });

    const claude = JSON.parse(
      fs.readFileSync(
        path.join(root, "config", "settings", ".claude", "settings.json"),
        "utf8",
      ),
    );
    expect(claude).toMatchObject({
      existingSetting: true,
      permissions: { defaultMode: "bypassPermissions" },
    });
    expect(
      fs.readFileSync(
        path.join(root, "config", "settings", ".codex", "config.toml"),
        "utf8",
      ),
    ).toContain('approval_policy = "never"');
  });

  test("creates only supported minimal bypass configurations", () => {
    const target = path.join(root, "target");
    expect(createMinimalBypassConfig(definition("Claude Code"), target)).toBe(
      true,
    );
    expect(createMinimalBypassConfig(definition("Codex"), target)).toBe(true);
    expect(createMinimalBypassConfig(definition("OpenCode"), target)).toBe(
      false,
    );
    expect(
      Object.keys(
        JSON.parse(
          fs.readFileSync(
            path.join(target, ".claude", "settings.json"),
            "utf8",
          ),
        ),
      ),
    ).toEqual(["permissions"]);
  });
});
