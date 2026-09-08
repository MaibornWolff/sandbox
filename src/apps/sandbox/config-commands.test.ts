import { describe, expect, test } from "bun:test";
import { stripAnsi } from "#test/utils.js";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

describe("config commands through the sandbox application", () => {
  test("shows defaults and routes output only to stdout", async () => {
    await using app = await setupSandboxAppTest();
    const result = await app.cli.run("config", "show");
    const defaultResult = await app.cli.run("config");
    const stdout = stripAnsi(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Sandbox Configuration");
    expect(stdout).toContain("Runtime: docker");
    expect(stdout).toContain("Readonly: false");
    expect(result.stderr).toBe("");
    expect(defaultResult).toEqual(result);
  });

  test("merges global, trusted project, environment, and CLI values without revealing secrets", async () => {
    await using app = await setupSandboxAppTest({
      variables: { API_TOKEN: "top-secret" },
    });
    app.global.writeConfig(
      'readonly = true\nallow_network = ["global.example"]\n',
    );
    app.project.writeConfig('allow_network = ["project.example:22"]\n', {
      trusted: true,
    });
    const result = await app.cli.run(
      "--env",
      "API_TOKEN",
      "--allow-network",
      "cli.example",
      "config",
      "show",
    );
    const output = stripAnsi(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(output).toContain("Readonly: true");
    expect(output).toContain("global.example");
    expect(output).toContain("project.example:22");
    expect(output).toContain("cli.example");
    expect(output).toContain("API_TOKEN=<redacted>");
    expect(output).not.toContain("top-secret");
  });

  test("shows all-port network rules in canonical host:* form", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig('allow_network = ["all.example:{*}"]\n');

    const result = await app.cli.run("config", "show");
    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toContain("all.example:*");
    expect(stripAnsi(result.stdout)).not.toContain("all.example:{*}");
  });

  test("expands global tilde mounts from the harness-owned home", async () => {
    await using app = await setupSandboxAppTest();
    app.workspace.writeHomeFile(".npmrc", "registry=https://example.test\n");
    app.global.writeConfig('mounts = ["~/.npmrc"]\n');

    const result = await app.cli.run("config", "show");
    const output = stripAnsi(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(output).toContain(`${app.workspace.homeRoot}/.npmrc`);
    expect(result.stderr).toBe("");
  });

  test("accepts an untrusted project after confirmation", async () => {
    await using app = await setupSandboxAppTest();
    app.project.writeConfig("readonly = true\n");
    const execution = app.cli.run("config", "show");
    await app.tui.waitForText("Trust this project config?");
    await app.tui.user.type("y");
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toContain("Readonly: true");
  });

  test("rejects declined and non-interactive untrusted project configuration", async () => {
    await using interactive = await setupSandboxAppTest();
    interactive.project.writeConfig("readonly = true\n");
    const execution = interactive.cli.run("config", "show");
    await interactive.tui.waitForText("Trust this project config?");
    await interactive.tui.user.type("n");
    const declined = await execution;
    expect(declined.exitCode).toBe(1);
    expect(stripAnsi(declined.stderr)).toContain("Project config not trusted");

    await using nonInteractive = await setupSandboxAppTest({
      interactive: false,
    });
    nonInteractive.project.writeConfig("readonly = true\n");
    const rejected = await nonInteractive.cli.run("config", "show");
    expect(rejected.exitCode).toBe(1);
    expect(stripAnsi(rejected.stderr)).toContain("Untrusted project config");
  });

  test("rejects invalid trusted project configuration", async () => {
    await using app = await setupSandboxAppTest();
    app.project.writeConfig('settings = [".claude/settings.json"]\n', {
      trusted: true,
    });

    const result = await app.cli.run("config", "show");

    expect(result.exitCode).not.toBe(0);
    expect(stripAnsi(result.stderr)).toContain("Invalid config at");
    expect(stripAnsi(result.stderr)).toContain("Invalid settings pattern");
  });

  test("rejects invalid configuration while missing files remain optional", async () => {
    await using malformedApp = await setupSandboxAppTest();
    malformedApp.global.writeConfig("readonly = [\n");
    const malformed = await malformedApp.cli.run("config", "show");
    expect(malformed.exitCode).not.toBe(0);
    expect(stripAnsi(malformed.stderr)).toContain("config.toml");

    await using invalidApp = await setupSandboxAppTest();
    invalidApp.global.writeConfig('runtime = "invalid"\n');
    const invalid = await invalidApp.cli.run("config", "show");
    expect(invalid.exitCode).not.toBe(0);
    expect(stripAnsi(invalid.stderr)).toContain("runtime");

    await using unknownTopLevelApp = await setupSandboxAppTest();
    unknownTopLevelApp.global.writeConfig("unexpected = true\n");
    const unknownTopLevel = await unknownTopLevelApp.cli.run("config", "show");
    expect(unknownTopLevel.exitCode).not.toBe(0);
    expect(stripAnsi(unknownTopLevel.stderr)).toContain("unexpected");

    await using unknownNestedApp = await setupSandboxAppTest();
    unknownNestedApp.global.writeConfig(
      'persist_paths = [{ path = "~/.cache", unexpected = true }]\n',
    );
    const unknownNested = await unknownNestedApp.cli.run("config", "show");
    expect(unknownNested.exitCode).not.toBe(0);
    expect(stripAnsi(unknownNested.stderr)).toContain("persist_paths.0");
    expect(stripAnsi(unknownNested.stderr)).toContain("unexpected");

    await using emptyApp = await setupSandboxAppTest();
    expect((await emptyApp.cli.run("config", "show")).exitCode).toBe(0);
  });

  test("prints schema, help, invalid-argument errors, and stable exit codes", async () => {
    await using app = await setupSandboxAppTest();
    const schema = await app.cli.run("config", "schema");
    expect(schema.exitCode).toBe(0);
    expect(schema.stdout).toContain("Sandbox Configuration Schema");
    expect(schema.stderr).toBe("");

    const help = await app.cli.run("config", "--help");
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("config schema");

    const invalid = await app.cli.run("config", "schema", "unexpected");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("too many arguments");
  });
});
