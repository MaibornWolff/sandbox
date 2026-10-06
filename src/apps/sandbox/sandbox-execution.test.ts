import { describe, expect, test } from "bun:test";
import { generateProjectSlug } from "#shared/text/index.js";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

function interactiveRequest(
  app: Awaited<ReturnType<typeof setupSandboxAppTest>>,
) {
  return app.processes.requests.find((request) => request.stdio === "inherit");
}

function givenSuccessfulInteractiveProcess(
  app: Awaited<ReturnType<typeof setupSandboxAppTest>>,
): void {
  app.processes
    .expectStart({ match: { stdio: "inherit" } })
    .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
}

describe("sandbox shell and run", () => {
  test("uses a versioned runtime cache and schedules cleanup after the session", async () => {
    await using app = await setupSandboxAppTest();
    givenSuccessfulInteractiveProcess(app);

    expect((await app.cli.run("run", "true")).exitCode).toBe(0);

    const container = app.runtime.containers.all()[0];
    const runtimeId = container?.labels["sandbox.runtime"];
    expect(runtimeId).toMatch(/^\d+\.\d+\.\d+[^/]*-[a-f0-9]{64}$/);
    expect(
      app.workspace.dataFileExists(
        `sandbox/runtime/${runtimeId}/dist/apps/sandbox/main.js`,
      ),
    ).toBe(true);
    expect(app.workspace.dataFileExists("sandbox/runtime/.last-cleanup")).toBe(
      true,
    );
  });
  test("executes the root shell through Commander and managed runtime state", async () => {
    await using app = await setupSandboxAppTest({
      variables: { TERM: "xterm-256color" },
    });
    givenSuccessfulInteractiveProcess(app);

    const result = await app.cli.run();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Creating sandbox container");
    expect(result.stderr).toContain("Starting sandbox shell");
    const request = interactiveRequest(app);
    expect(request).toMatchObject({ command: "docker", stdio: "inherit" });
    expect(request?.args).toContain("-it");
    expect(request?.args?.slice(-2)).toEqual([
      "/usr/local/bin/exec-entrypoint.sh",
      "zsh",
    ]);
    expect(app.runtime.containers.all()).toHaveLength(1);
  });

  test("preserves root shell child exit codes", async () => {
    await using app = await setupSandboxAppTest();
    app.processes
      .expectStart({ match: { stdio: "inherit" } })
      .resolveResult({ exitCode: 37, stdout: "", stderr: "" });

    const result = await app.cli.run("--verbose");

    expect(result.exitCode).toBe(37);
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).toContain("Stopped host command escape session");
  });

  test("attaches non-terminal stdin to the root shell without allocating a TTY", async () => {
    await using app = await setupSandboxAppTest({ interactive: false });
    givenSuccessfulInteractiveProcess(app);

    const result = await app.cli.run();

    expect(result.exitCode).toBe(0);
    const args = interactiveRequest(app)?.args ?? [];
    expect(args).toContain("-i");
    expect(args).not.toContain("-it");
    expect(args).not.toContain("-t");
    expect(args.slice(-2)).toEqual([
      "/usr/local/bin/exec-entrypoint.sh",
      "zsh",
    ]);
  });

  test("shows container information and rejects unknown root commands", async () => {
    await using inside = await setupSandboxAppTest({
      variables: { SANDBOX: "1" },
    });
    const info = await inside.cli.run();
    expect(info).toMatchObject({ exitCode: 0, stderr: "" });
    expect(info.stdout).toContain(
      "You are inside a sandboxed Docker container",
    );
    expect(inside.runtime.resolvedConfigurations()).toEqual([]);

    await using host = await setupSandboxAppTest();
    const unknown = await host.cli.run("unknown-lifecycle-command");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain(
      "error: unknown command 'unknown-lifecycle-command'",
    );
  });

  test("forwards run arguments, separator flags, stdin, and TTY mode", async () => {
    await using interactive = await setupSandboxAppTest({ interactive: true });
    givenSuccessfulInteractiveProcess(interactive);
    expect(
      (await interactive.cli.run("run", "--", "sh", "-c", "echo ok")).exitCode,
    ).toBe(0);
    const interactiveArgs = interactiveRequest(interactive)?.args ?? [];
    expect(interactiveArgs).toContain("-it");
    expect(interactiveArgs.slice(-4)).toEqual([
      "/usr/local/bin/exec-entrypoint.sh",
      "sh",
      "-c",
      "echo ok",
    ]);

    await using piped = await setupSandboxAppTest({ interactive: false });
    givenSuccessfulInteractiveProcess(piped);
    expect((await piped.cli.run("run", "node", "script.js")).exitCode).toBe(0);
    const pipedArgs = interactiveRequest(piped)?.args ?? [];
    expect(pipedArgs).toContain("-i");
    expect(pipedArgs).not.toContain("-it");
  });

  test("preserves silent validation, child exit codes, and title restoration", async () => {
    await using invalid = await setupSandboxAppTest();
    const conflict = await invalid.cli.run(
      "--verbose",
      "run",
      "--silent",
      "zsh",
    );
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain(
      "error: --silent cannot be used with --verbose",
    );

    await using failed = await setupSandboxAppTest();
    failed.processes
      .expectStart({ match: { name: "container log stream" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
    failed.processes
      .expectStart({ match: { stdio: "inherit" } })
      .resolveResult({ exitCode: 73, stdout: "", stderr: "" });
    const result = await failed.cli.run("run", "pi", "--verbose");
    expect(result.exitCode).toBe(73);
    expect(failed.processes.titles.history()).toEqual(["pi"]);
    expect(failed.processes.titles.current()).toBeNull();
  });

  test("reports configuration and runtime failures without spawning", async () => {
    await using malformed = await setupSandboxAppTest();
    const configFailure = await malformed.cli.run("--no-proxy", "run", "zsh");
    expect(configFailure.exitCode).toBe(1);
    expect(configFailure.stderr).toContain(
      "--no-proxy requires --full-network to be enabled",
    );
    expect(interactiveRequest(malformed)).toBeUndefined();

    await using runtimeFailure = await setupSandboxAppTest();
    runtimeFailure.runtime.system.fail("resolve", new Error("daemon offline"));
    const failure = await runtimeFailure.cli.run("run", "zsh");
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr).toContain("daemon offline");
    expect(interactiveRequest(runtimeFailure)).toBeUndefined();
  });

  test("emits scoped verbose timings without changing command execution", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig(`
[[allow_host_commands]]
pattern = ["tool", ["safe", { regex = 'profile-[0-9]+' }]]
`);
    app.processes
      .expectStart({ match: { name: "container log stream" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
    givenSuccessfulInteractiveProcess(app);
    const result = await app.cli.run("--verbose");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Load config completed");
    expect(result.stderr).toContain("Started host command escape session");
    expect(result.stderr.indexOf("Total startup completed")).toBeGreaterThan(
      result.stderr.indexOf("Started host command escape session"),
    );
    expect(result.stderr).toContain("Stopped host command escape session");
    expect(result.stderr).toContain("Exec command:");
    const execArgs = interactiveRequest(app)?.args ?? [];
    const tokenAssignment = execArgs.find((argument) =>
      argument.startsWith("SANDBOX_HOST_COMMAND_ESCAPE_TOKEN="),
    );
    expect(tokenAssignment).toBeDefined();
    expect(execArgs).toEqual(
      expect.arrayContaining([
        "SANDBOX_HOST_COMMAND_ESCAPE_PROTOCOL=sandbox-host-command-escape.v1",
      ]),
    );
    expect(result.stderr).not.toContain(tokenAssignment?.split("=")[1] ?? "");
    expect(result.stderr).toContain(
      "SANDBOX_HOST_COMMAND_ESCAPE_TOKEN=<redacted>",
    );
    expect(
      app.processes
        .actions()
        .find(
          (action) =>
            action.type === "start" &&
            action.request.name === "container log stream",
        ),
    ).toMatchObject({
      type: "start",
      request: {
        args: expect.arrayContaining(["logs", "--follow", "--tail", "200"]),
        stdio: "ignore",
        stdin: "ignore",
        onStdout: expect.any(Function),
        onStderr: expect.any(Function),
      },
    });
  });

  test("reports a missing image in no-build mode", async () => {
    await using app = await setupSandboxAppTest();
    const result = await app.cli.run("--no-build", "run", "zsh");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Image sandbox-base:latest is not available",
    );
  });

  test("reuses healthy containers and creates fresh containers when reuse is disabled", async () => {
    await using reused = await setupSandboxAppTest();
    givenSuccessfulInteractiveProcess(reused);
    expect((await reused.cli.run("run", "zsh")).exitCode).toBe(0);
    givenSuccessfulInteractiveProcess(reused);
    expect((await reused.cli.run("run", "zsh")).exitCode).toBe(0);
    expect(
      reused.runtime
        .events()
        .filter((event) => event.type === "container.create"),
    ).toHaveLength(1);

    await using app = await setupSandboxAppTest();
    givenSuccessfulInteractiveProcess(app);
    expect(
      (await app.cli.run("--no-container-reuse", "run", "zsh")).exitCode,
    ).toBe(0);
    givenSuccessfulInteractiveProcess(app);
    const second = await app.cli.run("--no-container-reuse", "run", "zsh");
    expect(second.exitCode).toBe(0);
    expect(app.runtime.containers.all()).toHaveLength(2);
  });

  test.each([
    { runtime: "docker" as const, entry: [] },
    { runtime: "docker" as const, entry: ["run", "true"] },
    { runtime: "podman" as const, entry: [] },
    { runtime: "podman" as const, entry: ["run", "true"] },
  ])(
    "reuses $runtime containers for session-only changes through $entry",
    async ({ runtime, entry }) => {
      await using app = await setupSandboxAppTest({ runtime });
      app.global.writeConfig(
        `runtime = "${runtime}"\nenv = ["SESSION_VALUE=global", "GLOBAL_VALUE=global"]\n`,
      );
      app.project.writeConfig('env = ["SESSION_VALUE=project"]\n', {
        trusted: true,
      });
      givenSuccessfulInteractiveProcess(app);
      const first = await app.cli.run(
        "--verbose",
        "--env",
        "SESSION_VALUE=first-secret",
        ...entry,
      );
      expect(first.exitCode).toBe(0);
      const builds = app.runtime
        .events()
        .filter((event) => event.type === "image.build").length;
      expect(builds).toBeGreaterThan(0);
      givenSuccessfulInteractiveProcess(app);
      expect(
        (await app.cli.run("--env", "SESSION_VALUE=second-secret", ...entry))
          .exitCode,
      ).toBe(0);
      app.global.writeConfig(`runtime = "${runtime}"\n`);
      app.project.writeConfig("", { trusted: true });
      givenSuccessfulInteractiveProcess(app);
      expect((await app.cli.run(...entry)).exitCode).toBe(0);

      const requests = app.processes.requests.filter(
        (request) => request.stdio === "inherit",
      );
      expect(requests).toHaveLength(3);
      expect(requests[0]?.args).toContain("SESSION_VALUE=first-secret");
      expect(requests[1]?.args).toContain("SESSION_VALUE=second-secret");
      for (const request of requests.slice(0, 2)) {
        expect(request.args).toContain("GLOBAL_VALUE=global");
        expect(
          request.args?.filter((arg) => arg.startsWith("SESSION_VALUE=")),
        ).toHaveLength(1);
      }
      expect(
        requests[2]?.args?.some(
          (arg) =>
            arg.startsWith("SESSION_VALUE=") || arg.startsWith("GLOBAL_VALUE="),
        ),
      ).toBe(false);
      const creations = app.runtime
        .events()
        .filter((event) => event.type === "container.create");
      expect(creations).toHaveLength(1);
      expect(
        creations[0]?.options.extraArgs?.some(
          (arg) =>
            arg.startsWith("SESSION_VALUE=") || arg.startsWith("GLOBAL_VALUE="),
        ),
      ).toBe(false);
      expect(
        app.runtime.events().filter((event) => event.type === "image.build"),
      ).toHaveLength(builds);
      expect(first.stderr).toContain("Startup environment variables");
      expect(first.stderr).toContain("Session environment variables");
      expect(first.stderr).not.toContain("first-secret");
    },
  );

  test.each([
    "SANDBOX",
    "SANDBOX_DEBUG",
    "SANDBOX_SETTINGS",
    "SANDBOX_CUSTOM",
    "CLAUDE_CODE_SSE_PORT",
    "DISPLAY",
    "X11_AVAILABLE",
  ])(
    "rejects reserved name %s before image preparation without exposing its value",
    async (name) => {
      await using app = await setupSandboxAppTest();
      const result = await app.cli.run(
        "--verbose",
        "--env",
        `${name}=confidential-value`,
        "run",
        "true",
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `Environment variable ${name} is reserved for Sandbox`,
      );
      expect(result.stderr).not.toContain("confidential-value");
      expect(
        app.runtime
          .events()
          .filter(
            (event) =>
              event.type === "image.build" || event.type === "container.create",
          ),
      ).toEqual([]);
      expect(interactiveRequest(app)).toBeUndefined();
    },
  );

  test("validates reserved names in global and trusted project configuration", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig('env = ["SANDBOX_RUNTIME=global-secret"]\n');
    expect((await app.cli.run()).stderr).toContain(
      "Environment variable SANDBOX_RUNTIME is reserved for Sandbox",
    );
    app.global.writeConfig("");
    app.project.writeConfig('env = ["DISPLAY=project-secret"]\n', {
      trusted: true,
    });
    const result = await app.cli.run("container", "start");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Environment variable DISPLAY is reserved for Sandbox",
    );
    expect(result.stderr).not.toContain("project-secret");
    expect(
      app.runtime.events().filter((event) => event.type === "image.build"),
    ).toEqual([]);
  });

  test("structural changes still select a new container", async () => {
    await using app = await setupSandboxAppTest();
    givenSuccessfulInteractiveProcess(app);
    expect((await app.cli.run("run", "true")).exitCode).toBe(0);
    app.runtime.system.fail(
      "container.exec",
      new Error("exit code 1: active session"),
    );
    givenSuccessfulInteractiveProcess(app);
    expect(await app.cli.run("--readonly", "run", "true")).toMatchObject({
      exitCode: 0,
    });
    expect(app.runtime.containers.all()).toHaveLength(2);
  });

  test("uses a new broker token for each execution in a reused container", async () => {
    await using app = await setupSandboxAppTest();
    givenSuccessfulInteractiveProcess(app);
    expect((await app.cli.run("run", "zsh")).exitCode).toBe(0);
    givenSuccessfulInteractiveProcess(app);
    expect((await app.cli.run("run", "zsh")).exitCode).toBe(0);

    const tokens = app.processes.requests
      .filter((request) => request.stdio === "inherit")
      .map((request) =>
        request.args?.find((argument) =>
          argument.startsWith("SANDBOX_HOST_COMMAND_ESCAPE_TOKEN="),
        ),
      );
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBeDefined();
    expect(tokens[1]).toBeDefined();
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  test("uses the runtime-specific broker host name", async () => {
    await using app = await setupSandboxAppTest({ runtime: "podman" });
    await app.project.givenConfig({ allowNetwork: [], runtime: "podman" });
    givenSuccessfulInteractiveProcess(app);

    expect((await app.cli.run("run", "zsh")).exitCode).toBe(0);

    expect(interactiveRequest(app)?.args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^SANDBOX_HOST_COMMAND_ESCAPE_ENDPOINT=ws:\/\/host\.containers\.internal:/u,
        ),
      ]),
    );
  });

  test("confirms home-root safety and suppresses its display in silent mode", async () => {
    await using rejected = await setupSandboxAppTest({ workspaceAtHome: true });
    await rejected.project.givenConfig({ allowNetwork: [] });
    const execution = rejected.cli.run("run", "zsh");
    await rejected.tui.waitForText(
      "Continue with home directory as workspace?",
    );
    await rejected.tui.user.enter();
    const result = await execution;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Project root is your home directory");
    expect(result.stdout).toContain(
      "Aborted. Run sandbox from a project directory",
    );
    expect(interactiveRequest(rejected)).toBeUndefined();

    await using accepted = await setupSandboxAppTest({ workspaceAtHome: true });
    await accepted.project.givenConfig({ allowNetwork: [] });
    givenSuccessfulInteractiveProcess(accepted);
    const silentExecution = accepted.cli.run("run", "--silent", "zsh");
    await accepted.tui.waitForText(
      "Continue with home directory as workspace?",
    );
    await accepted.tui.user.type("y");
    const silent = await silentExecution;
    expect(silent.exitCode).toBe(0);
    expect(silent.stderr).not.toContain("Project root is your home directory");
  });
});

describe("sandbox container start and stop", () => {
  test("foreground startup excludes configured session values and warns", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig('env = ["SESSION_VALUE=private-value"]\n');
    givenSuccessfulInteractiveProcess(app);
    const result = await app.cli.run(
      "--env",
      "CLI_VALUE=private-cli",
      "container",
      "start",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "does not start a session and does not apply env",
    );
    const args = interactiveRequest(app)?.args ?? [];
    expect(args).toContain("SANDBOX=1");
    expect(
      args.some(
        (arg) =>
          arg.startsWith("SESSION_VALUE=") || arg.startsWith("CLI_VALUE="),
      ),
    ).toBe(false);
    expect(result.stderr).not.toContain("private-value");
    expect(result.stderr).not.toContain("private-cli");
  });

  test("runs container start in the foreground with preserved guidance and exits", async () => {
    await using app = await setupSandboxAppTest();
    app.processes
      .expectStart({ match: { stdio: "inherit" } })
      .resolveResult({ exitCode: 17, stdout: "", stderr: "" });
    const result = await app.cli.run("--verbose", "container", "start");

    expect(result.exitCode).toBe(17);
    expect(result.stdout).toContain("Starting container");
    expect(result.stdout).toContain("in foreground (Ctrl+C to stop)");
    expect(result.stdout).toContain("Container stopped. Inspect with:");
    const args = interactiveRequest(app)?.args ?? [];
    expect(args.slice(0, 4)).toEqual([
      "run",
      "--init",
      "--name",
      expect.any(String),
    ]);
    expect(args).not.toContain("exec");
    expect(args).not.toContain("-i");
    expect(args).not.toContain("-it");
    expect(args).not.toContain("-t");
    expect(
      args.some((argument) => argument.includes("HOST_COMMAND_ESCAPE")),
    ).toBe(false);
    expect(result.stderr).not.toContain("host command escape session");

    await using existing = await setupSandboxAppTest();
    existing.runtime.images.create({
      id: "sha256:base",
      references: ["sandbox-base:latest"],
    });
    givenSuccessfulInteractiveProcess(existing);
    expect(
      (await existing.cli.run("--no-build", "container", "start")).exitCode,
    ).toBe(0);

    await using unavailable = await setupSandboxAppTest();
    unavailable.runtime.system.fail(
      "resolve",
      new Error("runtime unavailable"),
    );
    const failure = await unavailable.cli.run("container", "start");
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr).toContain("runtime unavailable");
  });

  test("stops project or all containers with confirmation, force, and partial failure", async () => {
    await using empty = await setupSandboxAppTest();
    const noContainers = await empty.cli.run("stop");
    expect(noContainers.exitCode).toBe(0);
    expect(noContainers.stderr).toContain("No running sandbox containers");

    await using confirmed = await setupSandboxAppTest();
    await confirmed.project.givenConfig({ allowNetwork: [] });
    const own = confirmed.project.givenContainer({
      state: "running",
      sessions: [{ pid: "42", command: "zsh" }],
    });
    confirmed.runtime.containers.create({
      name: "sandbox-other-project",
      image: "sandbox-base:latest",
      labels: { "sandbox.project": "other-project" },
      status: "running",
    });
    const execution = confirmed.cli.run("stop");
    await confirmed.tui.waitForText("with 1 active session(s)");
    await confirmed.tui.user.type("y");
    expect((await execution).exitCode).toBe(0);
    expect(
      confirmed.runtime.containers
        .all()
        .find((container) => container.id === own.id)?.status,
    ).toBe("removed");
    expect(
      confirmed.runtime.containers.find("sandbox-other-project")?.status,
    ).toBe("running");

    await using forced = await setupSandboxAppTest({ runtime: "podman" });
    forced.global.writeConfig('runtime = "podman"\n');
    await forced.project.givenConfig({ allowNetwork: [] });
    forced.project.givenContainer({ state: "running" });
    forced.runtime.containers.create({
      name: "sandbox-other-project",
      image: "sandbox-base:latest",
      labels: { "sandbox.project": "other-project" },
      status: "running",
    });
    forced.runtime.system.fail("container.stop", new Error("stop failed"));
    const all = await forced.cli.run("stop", "--all", "--force");
    expect(all.exitCode).toBe(0);
    expect(all.stderr).toContain("stop failed");
    expect(all.stderr).toContain("Stopped 1 container(s)");
    expect(forced.runtime.resolvedConfigurations()).toEqual(["podman"]);
  });

  test("cancels stop confirmation without changing runtime state", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const container = app.project.givenContainer({ state: "running" });
    const execution = app.cli.run("stop");
    await app.tui.waitForText("Continue?");
    await app.tui.user.enter();
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Cancelled");
    expect(app.runtime.containers.find(container.id)?.status).toBe("running");
  });

  test("settles stop confirmation when the user presses Ctrl-C", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const container = app.project.givenContainer({ state: "running" });
    const execution = app.cli.run("stop");
    await app.tui.waitForText("Continue?");

    await app.tui.user.chord("c", { ctrl: true });

    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Cancelled");
    expect(app.runtime.containers.find(container.id)?.status).toBe("running");
  });
});

test("overlapping host executions isolate runtime, process manager, terminal, clock, and files", async () => {
  await using first = await setupSandboxAppTest({
    variables: { TERM: "xterm" },
  });
  await using second = await setupSandboxAppTest({
    variables: { TERM: "dumb" },
  });
  givenSuccessfulInteractiveProcess(first);
  givenSuccessfulInteractiveProcess(second);
  const firstExecution = first.cli.run("run", "pi");
  const secondExecution = second.cli.run("run", "node");
  const [firstResult, secondResult] = await Promise.all([
    firstExecution,
    secondExecution,
  ]);
  expect(first.processes.manager).not.toBe(second.processes.manager);
  await first.clock.advanceBy(500);
  expect(first.clock.currentTime()).not.toBe(second.clock.currentTime());
  expect(first.project.root).not.toBe(second.project.root);
  expect(first.runtime.containers.all()).toHaveLength(1);
  expect(second.runtime.containers.all()).toHaveLength(1);
  expect(first.tui.output()).not.toBe("");
  expect(second.tui.output()).not.toBe("");

  expect(firstResult.exitCode).toBe(0);
  expect(secondResult.exitCode).toBe(0);
  expect(generateProjectSlug(first.project.root)).not.toBe(
    generateProjectSlug(second.project.root),
  );
});
