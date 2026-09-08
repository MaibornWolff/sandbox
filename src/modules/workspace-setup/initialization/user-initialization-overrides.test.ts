import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { getAgentConfigDefs } from "../agent-config-catalog.js";
import { detectExistingAgentConfigs } from "../agent-config-copying.js";
import { calculateOverrides } from "./agent-configuration-flow.js";

describe("calculateOverrides", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = createTestDir("init-overrides");
    home = path.join(root, "home");
  });
  afterEach(() => cleanupTestDir(root));

  async function calculate(options: {
    readonly selected: readonly string[];
    readonly existingTargets?: readonly string[];
    readonly addBypass?: boolean;
  }) {
    return (
      await runInHostTestScope({ root }, () => {
        for (const name of options.selected) {
          const definition = getAgentConfigDefs().find(
            (candidate) => candidate.name === name,
          );
          if (!definition?.settingsFile) throw new Error(`Missing ${name}`);
          const source = path.join(home, definition.settingsFile);
          fs.mkdirSync(path.dirname(source), { recursive: true });
          fs.writeFileSync(source, "{}");
        }
        for (const name of options.existingTargets ?? []) {
          const definition = getAgentConfigDefs().find(
            (candidate) => candidate.name === name,
          );
          if (!definition?.settingsFile) throw new Error(`Missing ${name}`);
          const target = path.join(
            root,
            "config",
            "settings",
            definition.settingsFile,
          );
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, "{}");
        }
        const detected = detectExistingAgentConfigs();
        const selected = detected.filter((config) =>
          options.selected.includes(config.name),
        );
        return calculateOverrides(
          selected,
          detected,
          options.addBypass ?? false,
        );
      })
    ).result;
  }

  it("returns no overrides without selected or existing targets", async () => {
    expect(await calculate({ selected: [] })).toEqual([]);
    expect(await calculate({ selected: ["Claude Code"] })).toEqual([]);
  });

  it("reports only selected copy targets", async () => {
    const overrides = await calculate({
      selected: ["Claude Code"],
      existingTargets: ["Claude Code", "Codex"],
      addBypass: true,
    });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      name: "Claude Code",
      isCopy: true,
      existingPaths: [".claude/settings.json"],
    });
  });
});
