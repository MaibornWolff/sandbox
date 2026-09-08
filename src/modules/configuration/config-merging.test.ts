import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanupTestDir,
  createPersistPath,
  createTestConfig,
  createTestDir,
} from "#test/utils.js";
import { runWithConfigurationTestScope } from "./__test__/index.js";
import type { Config } from "./config.js";
import {
  applyTomlConfig as applyTomlConfigInScope,
  CONFIG_MERGE_RULES,
} from "./config-merging.js";
import type { TomlConfig } from "./toml-config-schema.js";

const applyTomlConfig: typeof applyTomlConfigInScope = (...args) =>
  runWithConfigurationTestScope(() => applyTomlConfigInScope(...args));

describe("CONFIG_MERGE_RULES", () => {
  test("defines merge strategy for all Config fields", () => {
    expect(CONFIG_MERGE_RULES.runtime.strategy).toBe("override");
    expect(CONFIG_MERGE_RULES.mounts.strategy).toBe("accumulate");
    expect(CONFIG_MERGE_RULES.env.strategy).toBe("accumulate");
    expect(CONFIG_MERGE_RULES.readonly.strategy).toBe("override");
    expect(CONFIG_MERGE_RULES.persistPaths.strategy).toBe("accumulate");
    expect(CONFIG_MERGE_RULES.clipboard.strategy).toBe("override");
    expect(CONFIG_MERGE_RULES.settings.strategy).toBe("accumulate");
    expect(CONFIG_MERGE_RULES.ports.strategy).toBe("accumulate");
    expect(CONFIG_MERGE_RULES.allowNetwork.strategy).toBe("accumulate");
    expect(CONFIG_MERGE_RULES.allowHostCommands.strategy).toBe("accumulate");
    expect(CONFIG_MERGE_RULES.fullNetwork.strategy).toBe("override");
    expect(CONFIG_MERGE_RULES.noProxy.strategy).toBe("override");
    expect(CONFIG_MERGE_RULES.shmSize.strategy).toBe("override");
  });
});

function createBaseConfig(): Config {
  return createTestConfig();
}

const projectDir = "/test/project";
const tmpDir = os.tmpdir();

describe("applyTomlConfig - override strategy", () => {
  let baseConfig: Config;

  beforeEach(() => {
    baseConfig = createBaseConfig();
  });

  test("runtime overrides previous value", async () => {
    const toml: TomlConfig = {
      runtime: "podman",
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.runtime).toBe("podman");
  });

  test("readonly overrides previous value", async () => {
    baseConfig.readonly = false;

    const toml: TomlConfig = {
      readonly: true,
    };

    await applyTomlConfig(baseConfig, toml, "project", projectDir, {});

    expect(baseConfig.readonly).toBe(true);
  });

  test("clipboard overrides previous value", async () => {
    baseConfig.clipboard = "auto";

    const toml: TomlConfig = {
      clipboard: "disabled",
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.clipboard as Config["clipboard"]).toBe("disabled");
  });

  test("shm_size overrides previous value", async () => {
    const toml: TomlConfig = {
      shm_size: "1gb",
    };

    await applyTomlConfig(baseConfig, toml, "project", projectDir, {});

    expect(baseConfig.shmSize).toBe("1gb");
  });

  test("shm_size is undefined by default", () => {
    expect(baseConfig.shmSize).toBeUndefined();
  });
});

describe("applyTomlConfig - accumulate strategy", () => {
  let baseConfig: Config;

  beforeEach(() => {
    baseConfig = createBaseConfig();
  });

  test("mounts accumulate from global config", async () => {
    baseConfig.mounts = [`${tmpDir}:/mount:ro`];

    const toml: TomlConfig = {
      mounts: [`${tmpDir}:/new:rw`],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.mounts).toHaveLength(2);
    expect(baseConfig.mounts[0]).toBe(`${tmpDir}:/mount:ro`);
    expect(baseConfig.mounts[1]).toContain("/new");
  });

  test("mounts accumulate from project config", async () => {
    const testDir = createTestDir("merge-test");
    try {
      fs.mkdirSync(path.join(testDir, "relative", "path"), {
        recursive: true,
      });

      baseConfig.mounts = [`${tmpDir}:/mount:ro`];

      const toml: TomlConfig = {
        mounts: ["relative/path"],
      };

      await applyTomlConfig(baseConfig, toml, "project", testDir, {});

      expect(baseConfig.mounts).toHaveLength(2);
      expect(baseConfig.mounts[0]).toBe(`${tmpDir}:/mount:ro`);
      expect(baseConfig.mounts[1]).toContain("relative/path");
    } finally {
      cleanupTestDir(testDir);
    }
  });

  test("env accumulates", async () => {
    baseConfig.env = ["EXISTING_VAR=value1"];

    const toml: TomlConfig = {
      env: ["NEW_VAR"],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {
      NEW_VAR: "value2",
    });

    expect(baseConfig.env).toHaveLength(2);
    expect(baseConfig.env[0]).toBe("EXISTING_VAR=value1");
    expect(baseConfig.env[1]).toBe("NEW_VAR=value2");
  });

  test("settings accumulate", async () => {
    baseConfig.settings = [{ path: ".claude/*.json", mode: "mount" }];

    const toml: TomlConfig = {
      settings: ["~/.custom/*.json", "!~/.custom/cache"],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.settings).toEqual([
      { path: ".claude/*.json", mode: "mount" },
      { path: ".custom/*.json", mode: "mount" },
      { path: "!.custom/cache", mode: "mount" },
    ]);
  });

  test("settings accumulate from project config", async () => {
    baseConfig.settings = [{ path: ".claude/*.json", mode: "mount" }];

    const toml: TomlConfig = {
      settings: [{ path: "~/.project/config.json", mode: "copy" }],
    };

    await applyTomlConfig(baseConfig, toml, "project", projectDir, {});

    expect(baseConfig.settings).toEqual([
      { path: ".claude/*.json", mode: "mount" },
      { path: ".project/config.json", mode: "copy" },
    ]);
  });

  test("allowed host commands accumulate in order and remove structural duplicates", async () => {
    await applyTomlConfig(
      baseConfig,
      {
        allow_host_commands: [
          {
            pattern: ["open", { regex: ".+" }],
            test_match: [["open", "report.html"]],
          },
          { pattern: ["docker", "compose"] },
        ],
      },
      "global",
      projectDir,
      {},
    );
    await applyTomlConfig(
      baseConfig,
      {
        allow_host_commands: [
          {
            pattern: ["open", { regex: ".+" }],
            test_no_match: [["open"]],
          },
          { pattern: ["bun", "run", "test:e2e"] },
        ],
      },
      "project",
      projectDir,
      {},
    );

    expect(baseConfig.allowHostCommands).toEqual([
      ["open", { regex: ".+" }],
      ["docker", "compose"],
      ["bun", "run", "test:e2e"],
    ]);
  });

  test("persistPaths accumulate from global config", async () => {
    baseConfig.persistPaths = [createPersistPath(".cache")];

    const toml: TomlConfig = {
      persist_paths: [{ path: ".local" }, { path: ".config" }],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.persistPaths).toEqual([
      createPersistPath(".cache"),
      createPersistPath(".local"),
      createPersistPath(".config"),
    ]);
  });
});

describe("applyTomlConfig - persistPaths accumulation", () => {
  let baseConfig: Config;

  beforeEach(() => {
    baseConfig = createBaseConfig();
  });

  test("project config can add persistPaths", async () => {
    baseConfig.persistPaths = [createPersistPath(".cache")];

    const toml: TomlConfig = {
      persist_paths: [{ path: ".gradle" }],
    };

    await applyTomlConfig(baseConfig, toml, "project", projectDir, {});

    // Project paths should be added
    expect(baseConfig.persistPaths).toEqual([
      createPersistPath(".cache"),
      createPersistPath(".gradle"),
    ]);
  });

  test("global config can set persistPaths", async () => {
    baseConfig.persistPaths = [];

    const toml: TomlConfig = {
      persist_paths: [{ path: ".local" }, { path: ".config" }],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.persistPaths).toEqual([
      createPersistPath(".local"),
      createPersistPath(".config"),
    ]);
  });
});

describe("applyTomlConfig - undefined values", () => {
  let baseConfig: Config;

  beforeEach(() => {
    baseConfig = createBaseConfig();
  });

  test("undefined fields are not applied", async () => {
    const original = { ...baseConfig };

    const toml: TomlConfig = {};

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig).toEqual(original);
  });

  test("empty arrays are handled correctly", async () => {
    const toml: TomlConfig = {
      mounts: [],
      env: [],
      settings: [],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.mounts).toEqual([]);
    expect(baseConfig.env).toEqual([]);
    expect(baseConfig.settings).toEqual([]);
  });
});

describe("applyTomlConfig - env variable parsing", () => {
  let baseConfig: Config;

  beforeEach(() => {
    baseConfig = createBaseConfig();
  });

  test("includes set passthrough variables", async () => {
    const toml: TomlConfig = {
      env: ["SET_VAR"],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {
      SET_VAR: "exists",
    });

    expect(baseConfig.env).toEqual(["SET_VAR=exists"]);
  });

  test("skips unset passthrough variables", async () => {
    const toml: TomlConfig = {
      env: ["UNSET_VAR_12345"],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.env).toEqual([]);
  });

  test("includes explicit key=value pairs", async () => {
    const toml: TomlConfig = {
      env: ["EXPLICIT_VAR=explicit_value"],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {});

    expect(baseConfig.env).toEqual(["EXPLICIT_VAR=explicit_value"]);
  });

  test("mixes set and unset variables", async () => {
    const toml: TomlConfig = {
      env: ["SET_VAR", "UNSET_VAR", "EXPLICIT=value"],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {
      SET_VAR: "value",
    });

    expect(baseConfig.env).toEqual(["SET_VAR=value", "EXPLICIT=value"]);
  });
});

describe("applyTomlConfig - full merge scenarios", () => {
  let baseConfig: Config;

  beforeEach(() => {
    baseConfig = createBaseConfig();
  });

  test("global config applies all fields", async () => {
    const toml: TomlConfig = {
      runtime: "podman",
      mounts: [`${tmpDir}:/data:ro`],
      env: ["TEST_VAR"],
      readonly: true,
      persist_paths: [{ path: ".cache" }, { path: ".local" }],
      clipboard: "x11",
      settings: [".claude/*.json"],
      allow_host_commands: [{ pattern: ["open", { regex: ".+" }] }],
    };

    await applyTomlConfig(baseConfig, toml, "global", projectDir, {
      TEST_VAR: "test",
    });

    expect(baseConfig.runtime).toBe("podman");
    expect(baseConfig.mounts).toHaveLength(1);
    expect(baseConfig.env).toEqual(["TEST_VAR=test"]);
    expect(baseConfig.readonly).toBe(true);
    expect(baseConfig.persistPaths).toEqual([
      createPersistPath(".cache"),
      createPersistPath(".local"),
    ]);
    expect(baseConfig.clipboard).toBe("x11");
    expect(baseConfig.settings).toEqual([
      { path: ".claude/*.json", mode: "mount" },
    ]);
    expect(baseConfig.allowHostCommands).toEqual([["open", { regex: ".+" }]]);
  });

  test("project config applies all fields", async () => {
    const testDir = createTestDir("merge-test-project");
    try {
      fs.mkdirSync(path.join(testDir, "local"), { recursive: true });

      const toml: TomlConfig = {
        mounts: ["./local"],
        env: ["PROJECT_VAR"],
        readonly: false,
        persist_paths: [{ path: ".gradle" }],
        clipboard: "disabled",
        settings: [".project/*.json"],
      };

      await applyTomlConfig(baseConfig, toml, "project", testDir, {
        PROJECT_VAR: "value",
      });

      expect(baseConfig.mounts).toHaveLength(1);
      expect(baseConfig.env).toEqual(["PROJECT_VAR=value"]);
      expect(baseConfig.readonly).toBe(false);
      expect(baseConfig.persistPaths).toEqual([createPersistPath(".gradle")]); // Added from project
      expect(baseConfig.clipboard).toBe("disabled");
      expect(baseConfig.settings).toEqual([
        { path: ".project/*.json", mode: "mount" },
      ]);
    } finally {
      cleanupTestDir(testDir);
    }
  });

  test("sequential merges accumulate correctly", async () => {
    const testDir = createTestDir("merge-test-project");
    try {
      fs.mkdirSync(path.join(testDir, "project"), { recursive: true });

      const variables = {
        GLOBAL_VAR: "global",
        PROJECT_VAR: "project",
      };

      // Apply global config
      const globalToml: TomlConfig = {
        mounts: [`${tmpDir}:/global:ro`],
        env: ["GLOBAL_VAR"],
        settings: [".claude/*.json"],
        persist_paths: [{ path: ".cache" }],
      };

      await applyTomlConfig(
        baseConfig,
        globalToml,
        "global",
        testDir,
        variables,
      );

      // Apply project config
      const projectToml: TomlConfig = {
        mounts: ["./project"],
        env: ["PROJECT_VAR"],
        settings: [".project/*.json"],
        persist_paths: [{ path: ".gradle" }],
      };

      await applyTomlConfig(
        baseConfig,
        projectToml,
        "project",
        testDir,
        variables,
      );

      // Accumulating fields should have both
      expect(baseConfig.mounts).toHaveLength(2);
      expect(baseConfig.env).toEqual([
        "GLOBAL_VAR=global",
        "PROJECT_VAR=project",
      ]);
      expect(baseConfig.settings).toEqual([
        { path: ".claude/*.json", mode: "mount" },
        { path: ".project/*.json", mode: "mount" },
      ]);
      expect(baseConfig.persistPaths).toEqual([
        createPersistPath(".cache"),
        createPersistPath(".gradle"),
      ]);
    } finally {
      cleanupTestDir(testDir);
    }
  });
});
