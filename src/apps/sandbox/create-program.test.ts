import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
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

function listShortFlags(command: Command): string[] {
  return command.options.flatMap((option) =>
    option.short ? [option.short] : [],
  );
}

function listSubcommands(command: Command): Command[] {
  return command.commands.flatMap((subcommand) => [
    subcommand,
    ...listSubcommands(subcommand),
  ]);
}

describe("sandbox program metadata", () => {
  test("subcommand short flags never collide with global short flags", () => {
    const program = createScopedProgram();
    const globalShortFlags = new Set(listShortFlags(program));

    const collisions = listSubcommands(program).flatMap((command) =>
      listShortFlags(command)
        .filter((flag) => globalShortFlags.has(flag))
        .map((flag) => `${command.name()} ${flag}`),
    );

    expect(collisions).toEqual([]);
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
