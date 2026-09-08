import { describe, expect, test } from "bun:test";
import { createSystemClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createTestConfig } from "#test/utils.js";
import { showActiveConfig } from "./active-config-display.js";

function render(
  overrides: Parameters<typeof createTestConfig>[0] = {},
): string {
  const output: string[] = [];
  const logger = createLogger(
    createSystemClock(),
    (message) => output.push(message),
    {},
  );
  runWithDependencies([provideLogger(logger)], () =>
    showActiveConfig(createTestConfig(overrides)),
  );
  return output.join("\n");
}

describe("showActiveConfig", () => {
  test("shows nothing for default config", () => {
    expect(render()).toBe("");
  });

  test("summarizes active request values", () => {
    const output = render({
      readonly: true,
      mounts: ["/src:/dst:ro", "/another:/path:rw"],
      env: ["FOO=bar"],
      ports: ["127.0.0.1:8080:80"],
      allowHostCommands: [
        ["open", { regex: ".+" }],
        ["bun", "run", "test:e2e"],
      ],
      shmSize: "2g",
    });
    expect(output).toContain("readonly");
    expect(output).toContain("2 mount(s)");
    expect(output).toContain("1 env var(s)");
    expect(output).toContain("1 port(s)");
    expect(output).toContain("2 allowed host command rule(s)");
    expect(output).toContain("shm_size=2g");
  });
});
