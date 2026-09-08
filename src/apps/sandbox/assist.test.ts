import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

function plain(text: string): string {
  return stripVTControlCharacters(text);
}

describe("sandbox assist", () => {
  test("launches an explicit agent with the host prompt and question", async () => {
    await using app = await setupSandboxAppTest();
    const executable = app.assistance.givenExecutable({
      name: "Claude Code",
      command: "claude",
    });
    app.assistance.givenLaunchResult();

    const result = await app.cli.run(
      "assist",
      "How do I configure mounts?",
      "--agent",
      "claude",
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(plain(result.stdout)).toContain(
      "Launching claude with sandbox context",
    );
    expect(app.assistance.launches()).toEqual([
      {
        executable,
        args: [
          "--append-system-prompt",
          expect.stringContaining("You are running on the HOST"),
          "How do I configure mounts?",
        ],
        stdio: "inherit",
      },
    ]);
  });

  test("detects the highest-priority available supported agent", async () => {
    await using app = await setupSandboxAppTest();
    app.assistance.givenExecutable({ name: "Pi", command: "pi" });
    const codex = app.assistance.givenExecutable({
      name: "Codex",
      command: "codex",
    });
    app.assistance.givenLaunchResult();

    const result = await app.cli.run("assist", "Explain this setup");

    expect(result.exitCode).toBe(0);
    expect(plain(result.stdout)).toContain("Launching Codex");
    expect(app.assistance.launches()).toEqual([
      {
        executable: codex,
        args: [expect.stringContaining("Explain this setup")],
        stdio: "inherit",
      },
    ]);
  });

  test("reports when no supported agent can be detected", async () => {
    await using app = await setupSandboxAppTest();

    const result = await app.cli.run("assist", "Help me");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(plain(result.stderr)).toContain("No AI agent found");
    expect(plain(result.stderr)).toContain("sandbox assist --agent <command>");
    expect(app.assistance.launches()).toEqual([]);
  });

  test("launches an unsupported explicit agent through the fallback protocol", async () => {
    await using app = await setupSandboxAppTest();
    const executable = app.assistance.givenExecutable({
      name: "custom-agent",
      command: "custom-agent",
    });
    app.assistance.givenLaunchResult();

    const result = await app.cli.run(
      "assist",
      "Review my config",
      "--agent",
      "custom-agent",
    );

    expect(result.exitCode).toBe(0);
    expect(app.assistance.launches()).toEqual([
      {
        executable,
        args: [expect.stringContaining("Review my config")],
        stdio: "inherit",
      },
    ]);
  });

  test("constructs the host prompt from user and project paths and existing files", async () => {
    await using app = await setupSandboxAppTest();
    app.assistance.givenExecutable({ name: "Pi", command: "pi" });
    app.assistance.givenLaunchResult();
    app.global.writeConfig('runtime = "docker"\n');
    app.global.writeDockerfile("FROM sandbox-user\n");
    app.global.givenSettings({ "agent/config.json": "{}" });
    app.project.writeConfig('runtime = "podman"\n', { trusted: true });
    app.project.writeDockerfile("FROM sandbox-project\n");

    const result = await app.cli.run(
      "assist",
      "Which files apply?",
      "--agent",
      "pi",
    );
    const prompt = app.assistance.launches()[0]?.args[1] ?? "";

    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(
      `User config: ${path.join(app.workspace.configRoot, "config.toml")}`,
    );
    expect(prompt).toContain(
      `Project config: ${path.join(
        app.project.root,
        ".sandbox",
        "config.toml",
      )}`,
    );
    expect(prompt).toContain(
      `User Dockerfile: ${path.join(
        app.workspace.configRoot,
        "docker",
        "Dockerfile",
      )}`,
    );
    expect(prompt).toContain(
      `Project Dockerfile: ${path.join(
        app.project.root,
        ".sandbox",
        "docker",
        "Dockerfile",
      )}`,
    );
    expect(prompt).toContain(
      `Settings dir: ${path.join(app.workspace.configRoot, "settings")}`,
    );
    expect(prompt).toContain(
      "If the project-level file exists and the user did not specify scope, ask whether",
    );
    expect(prompt).toContain("README:");
    expect(prompt).toContain("Tool registry:");
  });

  test("keeps manual context for an agent without an interactive question", async () => {
    await using app = await setupSandboxAppTest();
    app.assistance.givenExecutable({
      name: "GitHub Copilot",
      command: "copilot",
    });

    const result = await app.cli.run("assist", "--agent", "copilot");

    const output = plain(result.stdout);
    const contextPath = output.match(
      /Sandbox context written to ([^\n]+)\./,
    )?.[1];
    try {
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(output).toContain("does not support automatic");
      expect(contextPath).toBeDefined();
      expect(output).toContain(
        'sandbox assist --agent copilot "your question"',
      );
      expect(app.assistance.launches()).toEqual([]);
    } finally {
      if (contextPath) {
        fs.rmSync(path.dirname(contextPath), { recursive: true, force: true });
      }
    }
  });

  test("preserves a nonzero agent exit and reports launch failures", async () => {
    await using exited = await setupSandboxAppTest();
    exited.assistance.givenExecutable({ name: "Pi", command: "pi" });
    exited.assistance.givenLaunchResult({ exitCode: 23 });

    const exitedResult = await exited.cli.run("assist", "--agent", "pi");

    expect(exitedResult).toMatchObject({
      exitCode: 23,
      stderr: "",
    });

    await using failed = await setupSandboxAppTest();
    failed.assistance.givenExecutable({ name: "Pi", command: "pi" });
    failed.assistance.givenLaunchFailure(new Error("permission denied"));

    const failedResult = await failed.cli.run("assist", "--agent", "pi");

    expect(failedResult.exitCode).toBe(1);
    expect(plain(failedResult.stderr)).toContain(
      "Failed to launch pi: permission denied",
    );
  });

  test("cancels an active agent launch through the application terminal", async () => {
    await using app = await setupSandboxAppTest();
    app.assistance.givenExecutable({ name: "Pi", command: "pi" });
    const child = app.processes.expectStart({ match: { stdio: "inherit" } });

    const execution = app.cli.run("assist", "--agent", "pi");
    await child.waitForStart();
    app.tui.cancel();
    child.rejectResult(
      new DOMException("The operation was aborted", "AbortError"),
    );
    const result = await execution;

    expect(result.exitCode).toBe(1);
    expect(plain(result.stderr)).toContain(
      "Failed to launch pi: The operation was aborted",
    );
  });

  test("isolates detected agents, launches, prompts, and output in parallel", async () => {
    await using first = await setupSandboxAppTest();
    await using second = await setupSandboxAppTest();
    first.assistance.givenExecutable({
      name: "Claude Code",
      command: "claude",
    });
    second.assistance.givenExecutable({ name: "Pi", command: "pi" });
    first.assistance.givenLaunchResult();
    second.assistance.givenLaunchResult();

    const [firstResult, secondResult] = await Promise.all([
      first.cli.run("assist", "first question"),
      second.cli.run("assist", "second question"),
    ]);

    expect(plain(firstResult.stdout)).toContain("Launching Claude Code");
    expect(plain(secondResult.stdout)).toContain("Launching Pi");
    expect(first.assistance.launches()[0]?.args).toContain("first question");
    expect(second.assistance.launches()[0]?.args).toContain("second question");
    expect(first.assistance.launches()[0]?.args.join("\n")).not.toContain(
      second.workspace.root,
    );
    expect(second.assistance.launches()[0]?.args.join("\n")).not.toContain(
      first.workspace.root,
    );
  });
});
