import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
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

  test("shows normalized hooks in order without printing their arguments", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig(`
[[hooks]]
event = "session.start"
command = ["./setup", "private-argument"]
wait = true
timeout = "1.5s"
`);
    app.project.writeConfig(
      `
[[hooks]]
event = "session.end"
command = ["./cleanup"]
`,
      { trusted: true },
    );
    const result = await app.cli.run("config", "show");
    expect(result.exitCode).toBe(0);
    const output = stripAnsi(result.stdout);
    const hooks = output
      .split("\n")
      .filter((line) => /^\s*session\.(start|end)\b/.test(line));
    expect(hooks.map((line) => line.trim().split(/\s+/)[0])).toEqual([
      "session.start",
      "session.end",
    ]);
    expect(hooks[0]).toContain("timeout=1500ms");
    expect(hooks[0]).toContain("on_error=fail");
    expect(hooks[1]).toContain("wait=false");
    expect(hooks[1]).toContain("timeout=none");
    expect(output).not.toContain("private-argument");
  });

  test("rejects mistyped config subcommands with a suggestion", async () => {
    await using app = await setupSandboxAppTest();

    const result = await app.cli.run("config", "updte");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: unknown command 'updte'\n(Did you mean update?)\n",
    );
  });

  test("shows Apple container as a first-class runtime value", async () => {
    await using app = await setupSandboxAppTest({ runtime: "apple-container" });
    app.global.writeConfig(
      'runtime = "apple-container"\n[runtimes.apple-container]\ndns = "host-ipv6"\n',
    );

    const result = await app.cli.run("config", "show");

    expect(result.exitCode).toBe(0);
    const output = stripAnsi(result.stdout);
    expect(output).toContain("Runtime: apple-container");
    expect(output).toContain("Apple container DNS: host-ipv6");
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

  test("shows and accepts external project mounts before saving trust", async () => {
    await using app = await setupSandboxAppTest();
    app.workspace.writeRootFile("[Team] shared/guide.txt", "reference");
    app.workspace.writeHomeFile("demo-cache/data.txt", "cache");
    app.workspace.writeHomeFile("global-only.txt", "global");
    app.global.writeConfig('mounts = ["~/global-only.txt"]\n');
    app.project.writeConfig(
      'mounts = ["../[Team] shared/guide.txt:/reference", "~/demo-cache:/cache:rw"]\n',
    );
    const reference = fs.realpathSync(
      path.join(app.workspace.root, "[Team] shared", "guide.txt"),
    );
    const cache = fs.realpathSync(
      path.join(app.workspace.homeRoot, "demo-cache"),
    );
    const execution = app.cli.run("config", "show");
    await app.tui.waitForText("Trust this project config?");
    const prompt = stripAnsi(app.tui.output());
    expect(prompt).toContain(
      `READ ONLY  ${JSON.stringify(reference)} → "/reference"`,
    );
    expect(prompt).toContain(`READ WRITE  ${JSON.stringify(cache)} → "/cache"`);
    expect(prompt).not.toContain("global-only.txt");
    expect(prompt).toContain(
      "Trust also approves the other settings in .sandbox.",
    );
    expect(app.workspace.configFileExists("trusted-projects.json")).toBe(false);
    await app.tui.user.type("y");
    const accepted = await execution;
    expect(accepted.exitCode).toBe(0);
    expect(stripAnsi(accepted.stdout)).toContain(
      `${reference} → /reference ro`,
    );
    expect(stripAnsi(accepted.stdout)).toContain(`${cache} → /cache rw`);
    const next = await app.cli.run("config", "show");
    expect(next.exitCode).toBe(0);
    expect(stripAnsi(next.stderr)).not.toContain("Trust this project config?");
  });

  test("declines external project mounts without recording trust", async () => {
    await using app = await setupSandboxAppTest();
    app.workspace.writeRootFile("shared/guide.txt", "reference");
    app.project.writeConfig('mounts = ["../shared/guide.txt:/reference"]\n');
    const execution = app.cli.run("config", "show");
    await app.tui.waitForText("Trust this project config?");
    await app.tui.user.enter();
    const result = await execution;
    expect(result.exitCode).toBe(1);
    expect(app.workspace.configFileExists("trusted-projects.json")).toBe(false);
  });

  test("requires new approval when a project mount symlink changes target", async () => {
    await using app = await setupSandboxAppTest();
    app.workspace.writeRootFile("shared/first.txt", "first");
    app.workspace.writeRootFile("shared/second.txt", "second");
    const first = fs.realpathSync(
      path.join(app.workspace.root, "shared", "first.txt"),
    );
    const second = fs.realpathSync(
      path.join(app.workspace.root, "shared", "second.txt"),
    );
    const link = path.join(app.project.root, "reference");
    fs.symlinkSync(first, link);
    app.project.writeConfig('mounts = ["./reference:/reference"]\n');
    expect((await app.cli.run("--trust", "config", "show")).exitCode).toBe(0);
    fs.unlinkSync(link);
    fs.symlinkSync(second, link);
    const execution = app.cli.run("config", "show");
    await app.tui.waitForText("Trust this project config?");
    const prompt = stripAnsi(app.tui.output());
    expect(prompt).toContain("Project config or mount access has changed");
    expect(prompt).toContain(
      `READ ONLY  ${JSON.stringify(second)} → "/reference"`,
    );
    await app.tui.user.type("y");
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toContain(`${second} → /reference ro`);
  });

  test("escapes untrusted mount diagnostics before approval, including verbose output", async () => {
    await using app = await setupSandboxAppTest();
    const control = "\u001b]52;c;ZGVtbw==\u0007";
    app.project.writeConfig(
      `mounts = [${JSON.stringify(`/fictional/missing/${control}:/reference`)}]\n`,
    );
    const execution = app.cli.run("--verbose", "config", "show");
    await app.tui.waitForText("Trust this project config?");
    const output = app.tui.output();
    expect(output).not.toContain(control);
    expect(output).toContain("\\u001b]52;c;ZGVtbw==\\u0007");
    await app.tui.user.type("n");
    const result = await execution;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(control);
  });

  test("rejects a reviewed mount source replaced while approval is pending", async () => {
    await using app = await setupSandboxAppTest();
    const reference = path.join(app.project.root, "reference");
    fs.mkdirSync(reference);
    app.workspace.writeRootFile("private/secret.txt", "private data");
    const privateDirectory = fs.realpathSync(
      path.join(app.workspace.root, "private"),
    );
    app.project.writeConfig('mounts = ["./reference:/reference:rw"]\n');
    const execution = app.cli.run("config", "show");
    await app.tui.waitForText("Trust this project config?");
    fs.rmdirSync(reference);
    fs.symlinkSync(privateDirectory, reference);
    await app.tui.user.type("y");
    const result = await execution;
    expect(result.exitCode).toBe(1);
    expect(stripAnsi(result.stderr)).toContain(
      "Project configuration or mount access changed during approval. Run the command again to review it.",
    );
    expect(app.workspace.configFileExists("trusted-projects.json")).toBe(false);
  });

  test("shows the full current mount list when project configuration changes", async () => {
    await using app = await setupSandboxAppTest();
    app.workspace.writeRootFile("shared/guide.txt", "reference");
    app.project.writeConfig('mounts = ["../shared/guide.txt:/reference"]\n');
    expect((await app.cli.run("--trust", "config", "show")).exitCode).toBe(0);
    app.project.writeConfig('mounts = ["../shared/guide.txt:/reference:rw"]\n');
    const source = fs.realpathSync(
      path.join(app.workspace.root, "shared", "guide.txt"),
    );
    const execution = app.cli.run("config", "show");
    await app.tui.waitForText("Trust this project config?");
    const prompt = stripAnsi(app.tui.output());
    expect(prompt).toContain(
      `READ WRITE  ${JSON.stringify(source)} → "/reference"`,
    );
    expect(prompt).not.toContain("NEW ");
    expect(prompt).not.toContain("CHANGED ");
    await app.tui.user.type("n");
    expect((await execution).exitCode).toBe(1);
  });

  test("rejects newly available project mount access without non-interactive approval", async () => {
    await using app = await setupSandboxAppTest({ interactive: false });
    app.project.writeConfig('mounts = ["../shared/guide.txt:/reference"]\n');
    const initial = await app.cli.run("--trust", "config", "show");
    expect(initial.exitCode).toBe(0);
    expect(stripAnsi(initial.stderr)).toContain(
      "Skipping mount because source path does not exist",
    );
    app.workspace.writeRootFile("shared/guide.txt", "reference");
    const rejected = await app.cli.run("config", "show");
    expect(rejected.exitCode).toBe(1);
    expect(stripAnsi(rejected.stderr)).toContain("Untrusted project config");
    const accepted = await app.cli.run("--trust", "config", "show");
    expect(accepted.exitCode).toBe(0);
    expect(stripAnsi(accepted.stdout)).toContain(" → /reference ro");
    expect(stripAnsi(accepted.stderr)).not.toContain(
      "Trust this project config?",
    );
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
