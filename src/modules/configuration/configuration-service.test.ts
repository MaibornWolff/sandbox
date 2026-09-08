import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import {
  createProcessTerminal,
  provideTerminal,
} from "#platform/terminal/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { writeTrustedProjectConfig } from "./__test__/index.js";
import {
  createConfigurationService,
  getConfigurationService,
  provideConfigurationService,
} from "./configuration-service.js";

function withConfiguration<T>(
  root: string,
  callback: (service: ReturnType<typeof createConfigurationService>) => T,
  variables: Readonly<Record<string, string>> = { SANDBOX_TRUST_ALL: "1" },
): T {
  const clock = createTestClock(Date.UTC(2026, 0, 1));
  const stream = new PassThrough();
  return runWithDependencies(
    [
      provideHostEnvironment(
        createHostEnvironment({
          currentWorkingDirectory: path.join(root, "project"),
          homeDirectory: path.join(root, "home"),
          variables: {
            SANDBOX_CONFIG_DIR: path.join(root, "config"),
            ...variables,
          },
          platform: "linux",
          interactive: false,
        }),
      ),
      provideClock(clock.clock),
      provideTerminal(
        createProcessTerminal({
          signal: new AbortController().signal,
          streams: {
            input: new PassThrough(),
            stdout: stream,
            stderr: stream,
          },
        }),
      ),
      provideLogger(createLogger(clock.clock, () => undefined, {})),
    ],
    () => callback(createConfigurationService()),
  );
}

describe("configuration service", () => {
  test("publishes the application-owned service only inside its nested scope", () => {
    const root = createTestDir("configuration-service-scope");
    try {
      withConfiguration(root, (service) => {
        const missingDependencyMessage =
          'Dependency "configuration service" is not registered in the active scope.';
        expect(() => getConfigurationService()).toThrow(
          missingDependencyMessage,
        );
        runWithDependencies([provideConfigurationService(service)], () => {
          expect(getConfigurationService()).toBe(service);
        });
        expect(() => getConfigurationService()).toThrow(
          missingDependencyMessage,
        );
      });
    } finally {
      cleanupTestDir(root);
    }
  });

  test("loads overlays and updates allowed networks below scoped roots", async () => {
    const root = createTestDir("configuration-service");
    const projectRoot = path.join(root, "project");
    const globalPath = path.join(root, "config", "config.toml");
    fs.mkdirSync(path.join(projectRoot, ".sandbox"), { recursive: true });
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, 'allow_network = ["existing.example"]\n');
    try {
      await withConfiguration(root, async (service) => {
        const loaded = await service.load({});
        expect(loaded.projectRoot).toBe(projectRoot);
        expect(loaded.config.allowNetwork[0]?.host).toBe("existing.example");
        service.updateAllowedNetwork({
          target: "global",
          projectRoot,
          domains: ["api.example:443"],
        });
      });
      expect(fs.readFileSync(globalPath, "utf8")).toContain(
        '"api.example:443"',
      );
    } finally {
      cleanupTestDir(root);
    }
  });

  test("accepts an unchanged trusted config and rejects it after modification", async () => {
    const root = createTestDir("configuration-service-trust");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const projectRoot = path.join(root, "project");
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(
      path.join(configRoot, "config.toml"),
      `[[allow_host_commands]]
pattern = ["open", { regex = ".+" }]
test_match = [["open", "report.html"]]

[[allow_host_commands]]
pattern = ["docker", ["compose", "run"]]
`,
    );
    writeTrustedProjectConfig({
      projectRoot,
      trustStorePath: path.join(configRoot, "trusted-projects.json"),
      allowNetwork: [{ host: "all.example", ports: "*", wildcard: false }],
      allowHostCommands: [
        ["bun", "run", "test:e2e"],
        ["open", { regex: ".+" }],
        ["tool", { repeat: ["one", "two"], min: 1, max: 2 }],
      ],
    });
    const configPath = path.join(projectRoot, ".sandbox", "config.toml");
    expect(fs.readFileSync(configPath, "utf8")).toContain('"all.example:*"');
    const loaded = await withConfiguration(
      root,
      (service) => service.load({}),
      {},
    );
    expect(loaded.config.allowNetwork).toContainEqual({
      host: "all.example",
      ports: "*",
      wildcard: false,
    });
    expect(loaded.config.allowHostCommands).toEqual([
      ["open", { regex: ".+" }],
      ["docker", ["compose", "run"]],
      ["bun", "run", "test:e2e"],
      ["tool", { repeat: ["one", "two"], min: 1, max: 2 }],
    ]);
    fs.appendFileSync(configPath, "readonly = true\n");
    await expect(
      withConfiguration(root, (service) => service.load({}), {}),
    ).rejects.toThrow("Project config is not trusted.");
  });
});
