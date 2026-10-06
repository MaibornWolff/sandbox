import { describe, expect, test } from "bun:test";
import { generateProjectSlug } from "#shared/text/index.js";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

function interactiveRequest(
  app: Awaited<ReturnType<typeof setupSandboxAppTest>>,
) {
  return app.processes.requests.find((request) => request.stdio === "inherit");
}

function attachedExecution(
  app: Awaited<ReturnType<typeof setupSandboxAppTest>>,
) {
  return app.runtime
    .events()
    .findLast((event) => event.type === "container.exec-attached");
}

function givenSuccessfulInteractiveProcess(
  app: Awaited<ReturnType<typeof setupSandboxAppTest>>,
): void {
  app.processes
    .expectStart({ match: { stdio: "inherit" } })
    .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
}

describe("sandbox shell and run", () => {
  test("overlaps X11 detection with host validation and waits on host failure", async () => {
    await using app = await setupSandboxAppTest({
      platform: "darwin",
      runtimeBoundary: "process",
    });
    app.global.writeConfig('runtime = "docker"\n');
    const host = app.processes.expectStart({
      match: { command: "docker", args: ["--version"] },
    });
    const x11 = app.processes.expectStart({ match: { command: "pgrep" } });
    let completed = false;
    const execution = app.cli
      .run("--no-build", "run", "true")
      .then((result) => {
        completed = true;
        return result;
      });
    await host.waitForStart();
    const detectionStarted = app.processes.requests.some(
      (request) => request.command === "pgrep",
    );
    host.resolveResult({ exitCode: 1, stdout: "", stderr: "offline" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completedBeforeDetection = completed;
    x11.resolveResult({ exitCode: 0, stdout: "123", stderr: "" });
    const result = await execution;
    expect(detectionStarted).toBe(true);
    expect(completedBeforeDetection).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Docker daemon is not running");
    expect(result.stderr).not.toContain("X11 clipboard not available");
  });

  test.each([
    { silent: false, available: false, clipboard: "auto" },
    { silent: true, available: false, clipboard: "auto" },
    { silent: false, available: true, clipboard: "auto" },
    { silent: false, available: false, clipboard: "disabled" },
  ])(
    "detects X11 once and preserves warning behavior: %j",
    async ({ silent, available, clipboard }) => {
      await using app = await setupSandboxAppTest({ platform: "darwin" });
      app.global.writeConfig(`clipboard = "${clipboard}"\n`);
      app.processes.expectStart({ match: { command: "pgrep" } }).resolveResult({
        exitCode: available ? 0 : 1,
        stdout: available ? "123" : "",
        stderr: "",
      });
      givenSuccessfulInteractiveProcess(app);
      const result = await app.cli.run(
        "run",
        ...(silent ? ["--silent"] : []),
        "true",
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr.includes("X11 clipboard not available")).toBe(
        !silent && !available && clipboard !== "disabled",
      );
      expect(
        app.processes.requests.filter((request) => request.command === "pgrep"),
      ).toHaveLength(1);
      expect(
        app.runtime.events().find((event) => event.type === "container.create")
          ?.options.environment.X11_AVAILABLE,
      ).toBe(String(available));
    },
  );
  test("uses a versioned runtime cache and schedules cleanup after the session", async () => {
    await using app = await setupSandboxAppTest();
    givenSuccessfulInteractiveProcess(app);

    expect((await app.cli.run("run", "true")).exitCode).toBe(0);

    const container = app.runtime.instances.all()[0];
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
    const execution = attachedExecution(app);
    expect(execution?.spec.command).toEqual([
      "/usr/local/bin/exec-entrypoint.sh",
      "zsh",
    ]);
    expect(execution?.session).toMatchObject({
      attachStdin: true,
      allocateTerminal: true,
    });
    expect(app.runtime.instances.all()).toHaveLength(1);
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
    expect(attachedExecution(app)?.session).toMatchObject({
      attachStdin: true,
      allocateTerminal: false,
    });
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
    expect(attachedExecution(interactive)).toMatchObject({
      spec: {
        command: ["/usr/local/bin/exec-entrypoint.sh", "sh", "-c", "echo ok"],
      },
      session: { attachStdin: true, allocateTerminal: true },
    });

    await using piped = await setupSandboxAppTest({ interactive: false });
    givenSuccessfulInteractiveProcess(piped);
    expect((await piped.cli.run("run", "node", "script.js")).exitCode).toBe(0);
    expect(attachedExecution(piped)?.session).toMatchObject({
      attachStdin: true,
      allocateTerminal: false,
    });
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
    await using malformed = await setupSandboxAppTest({ platform: "darwin" });
    const configFailure = await malformed.cli.run("--no-proxy", "run", "zsh");
    expect(configFailure.exitCode).toBe(1);
    expect(configFailure.stderr).toContain(
      "--no-proxy requires --full-network to be enabled",
    );
    expect(interactiveRequest(malformed)).toBeUndefined();
    expect(
      malformed.processes.requests.some(
        (request) => request.command === "pgrep",
      ),
    ).toBe(false);

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
    expect(result.stderr).toContain("Exec mode:");
    const executionEnvironment = attachedExecution(app)?.spec.environment;
    const token = executionEnvironment?.SANDBOX_HOST_COMMAND_ESCAPE_TOKEN;
    expect(token).toBeDefined();
    expect(executionEnvironment).toMatchObject({
      SANDBOX_HOST_COMMAND_ESCAPE_PROTOCOL: "sandbox-host-command-escape.v1",
    });
    expect(result.stderr).not.toContain(token ?? "");
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
      "No complete image record exists for sandbox-base:latest",
    );
    expect(result.stderr).toContain("Run sandbox build first");
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
    expect(app.runtime.instances.all()).toHaveLength(2);
  });

  test("prepares new and reused sessions before execution", async () => {
    await using app = await setupSandboxAppTest();
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = app.runtime.events().length;
      givenSuccessfulInteractiveProcess(app);
      expect((await app.cli.run("run", "true")).exitCode).toBe(0);
      const events = app.runtime.events().slice(start);
      const attached = events.findIndex(
        (event) => event.type === "container.exec-attached",
      );
      expect(attached).toBeGreaterThan(0);
      const preparation = events
        .slice(0, attached)
        .filter((event) => event.type === "container.exec");
      expect(preparation).toHaveLength(1);
      expect(
        events
          .slice(attached)
          .filter((event) => event.type === "container.exec"),
      ).toHaveLength(1);
    }
  });

  test("recovers when a reused container stops during readiness", async () => {
    await using app = await setupSandboxAppTest();
    givenSuccessfulInteractiveProcess(app);
    expect((await app.cli.run("run", "true")).exitCode).toBe(0);
    const previous = app.runtime.instances.all()[0];
    expect(previous).toBeDefined();
    if (!previous) throw new Error("Missing initial container");
    const runtime = (await app.runtime.provider.resolve()).runtime;
    await runtime.instances.remove(previous.id, { force: true });
    const reused = app.runtime.instances.create({
      name: previous.name,
      image: previous.image,
      labels: previous.labels,
      status: "running",
    });
    reused.givenStopsOnReadinessAttempt(1);
    givenSuccessfulInteractiveProcess(app);
    expect((await app.cli.run("run", "true")).exitCode).toBe(0);
    expect(reused.snapshot().status).toBe("removed");
    const attached = app.runtime
      .events()
      .filter((event) => event.type === "container.exec-attached");
    expect(attached).toHaveLength(2);
    expect(attached[1]?.containerId).not.toBe(reused.id);
  });

  test.each([
    { runtime: "docker" as const, entry: [] },
    { runtime: "docker" as const, entry: ["run", "true"] },
    { runtime: "podman" as const, entry: [] },
    { runtime: "podman" as const, entry: ["run", "true"] },
    { runtime: "apple-container" as const, entry: [] },
    { runtime: "apple-container" as const, entry: ["run", "true"] },
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

      const executions = app.runtime
        .events()
        .filter((event) => event.type === "container.exec-attached");
      expect(executions).toHaveLength(3);
      expect(executions[0]?.spec.environment).toMatchObject({
        SESSION_VALUE: "first-secret",
        GLOBAL_VALUE: "global",
      });
      expect(executions[1]?.spec.environment).toMatchObject({
        SESSION_VALUE: "second-secret",
        GLOBAL_VALUE: "global",
      });
      expect(executions[2]?.spec.environment).not.toHaveProperty(
        "SESSION_VALUE",
      );
      expect(executions[2]?.spec.environment).not.toHaveProperty(
        "GLOBAL_VALUE",
      );
      const creations = app.runtime
        .events()
        .filter((event) => event.type === "container.create");
      expect(creations).toHaveLength(1);
      expect(creations[0]?.options.environment).not.toHaveProperty(
        "SESSION_VALUE",
      );
      expect(creations[0]?.options.environment).not.toHaveProperty(
        "GLOBAL_VALUE",
      );
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
    givenSuccessfulInteractiveProcess(app);
    expect(await app.cli.run("--readonly", "run", "true")).toMatchObject({
      exitCode: 0,
    });
    const creations = app.runtime
      .events()
      .filter((event) => event.type === "container.create");
    expect(creations).toHaveLength(2);
    expect(creations[0]?.options.labels?.["sandbox.hash"]).not.toBe(
      creations[1]?.options.labels?.["sandbox.hash"],
    );
  });

  test("uses a new broker token for each execution in a reused container", async () => {
    await using app = await setupSandboxAppTest();
    givenSuccessfulInteractiveProcess(app);
    expect((await app.cli.run("run", "zsh")).exitCode).toBe(0);
    givenSuccessfulInteractiveProcess(app);
    expect((await app.cli.run("run", "zsh")).exitCode).toBe(0);

    const tokens = app.runtime
      .events()
      .filter((event) => event.type === "container.exec-attached")
      .map(
        (event) => event.spec.environment?.SANDBOX_HOST_COMMAND_ESCAPE_TOKEN,
      );
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBeDefined();
    expect(tokens[1]).toBeDefined();
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  test.each([
    ["docker", "host.docker.internal"],
    ["podman", "host.containers.internal"],
    ["apple-container", "host.container.internal"],
  ] as const)(
    "uses the resolved %s host name for the host-command broker",
    async (runtime, hostAccessName) => {
      await using app = await setupSandboxAppTest({ runtime });
      await app.project.givenConfig({ allowNetwork: [], runtime });
      givenSuccessfulInteractiveProcess(app);

      expect((await app.cli.run("run", "zsh")).exitCode).toBe(0);

      expect(
        attachedExecution(app)?.spec.environment
          ?.SANDBOX_HOST_COMMAND_ESCAPE_ENDPOINT,
      ).toStartWith(`ws://${hostAccessName}:`);
    },
  );

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
    const creation = app.runtime
      .events()
      .find((event) => event.type === "container.create");
    expect(creation?.options.environment.SANDBOX).toBe("1");
    expect(creation?.options.environment).not.toHaveProperty("SESSION_VALUE");
    expect(creation?.options.environment).not.toHaveProperty("CLI_VALUE");
    expect(attachedExecution(app)).toBeUndefined();
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
    expect(app.runtime.instances.all()).toHaveLength(1);
    expect(attachedExecution(app)).toBeUndefined();
    expect(result.stderr).not.toContain("host command escape session");

    await using existing = await setupSandboxAppTest();
    existing.runtime.images.create({
      id: "sha256:base",
      references: ["sandbox-base:latest"],
    });
    existing.runtime.images.givenNextBuild({ id: `sha256:${"a".repeat(64)}` });
    expect((await existing.cli.run("build")).exitCode).toBe(0);
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
    confirmed.runtime.instances.create({
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
      confirmed.runtime.instances
        .all()
        .find((container) => container.id === own.id)?.status,
    ).toBe("removed");
    expect(
      confirmed.runtime.instances.find("sandbox-other-project")?.status,
    ).toBe("running");

    await using forced = await setupSandboxAppTest({ runtime: "podman" });
    forced.global.writeConfig('runtime = "podman"\n');
    await forced.project.givenConfig({ allowNetwork: [] });
    forced.project.givenContainer({ state: "running" });
    forced.runtime.instances.create({
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
    expect(app.runtime.instances.find(container.id)?.status).toBe("running");
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
    expect(app.runtime.instances.find(container.id)?.status).toBe("running");
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
  expect(first.runtime.instances.all()).toHaveLength(1);
  expect(second.runtime.instances.all()).toHaveLength(1);
  expect(first.tui.output()).not.toBe("");
  expect(second.tui.output()).not.toBe("");

  expect(firstResult.exitCode).toBe(0);
  expect(secondResult.exitCode).toBe(0);
  expect(generateProjectSlug(first.project.root)).not.toBe(
    generateProjectSlug(second.project.root),
  );
});
