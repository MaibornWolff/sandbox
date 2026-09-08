import { describe, expect, test } from "bun:test";
import { createSystemClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createProgram } from "./index.js";

function createScopedProgram(variables: Readonly<Record<string, string>> = {}) {
  const environment = createHostEnvironment({
    currentWorkingDirectory: "/project",
    homeDirectory: "/home/tester",
    variables,
    platform: "linux",
    interactive: false,
  });
  return runWithDependencies(
    [
      provideHostEnvironment(environment),
      provideLogger(createLogger(createSystemClock(), () => undefined, {})),
    ],
    () => createProgram(),
  );
}

describe("sandbox program metadata", () => {
  test("registers every root subcommand exactly once", () => {
    const program = createScopedProgram();
    const names = program.commands.map((command) => command.name());

    expect(names).toEqual([
      "run",
      "escape",
      "build",
      "upgrade",
      "migrate",
      "status",
      "stop",
      "init",
      "clean",
      "setup-x11",
      "update",
      "doctor",
      "config",
      "assist",
      "network",
      "container",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  test("exposes no-build globally and silent only on run", () => {
    const program = createScopedProgram();
    const rootHelp = program.helpInformation();
    const run = program.commands.find((command) => command.name() === "run");
    const runHelp = run?.helpInformation() ?? "";

    expect(rootHelp).toContain("--no-build");
    expect(rootHelp).not.toContain("--silent");
    expect(runHelp).toContain("-s, --silent");
    expect(runHelp.match(/^\s+--no-build\b/gm) ?? []).toHaveLength(1);
  });

  test("shows host-only guidance in sandbox help", () => {
    const program = createScopedProgram({ SANDBOX: "1" });
    let help = "";
    program.configureOutput({
      writeOut: (text) => {
        help += text;
      },
    });

    program.outputHelp();

    expect(help).toContain("Running inside sandbox");
    expect(help).toContain("Some commands are host-only");
  });

  test("container start inherits no-build exactly once", () => {
    const program = createScopedProgram();
    const container = program.commands.find(
      (command) => command.name() === "container",
    );
    const start = container?.commands.find(
      (command) => command.name() === "start",
    );

    expect(
      start?.helpInformation().match(/^\s+--no-build\b/gm) ?? [],
    ).toHaveLength(1);
  });
});
