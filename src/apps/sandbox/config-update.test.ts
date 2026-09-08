import { describe, expect, test } from "bun:test";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

type App = Awaited<ReturnType<typeof setupSandboxAppTest>>;

async function openDiffActions(app: App, fileName: string): Promise<void> {
  await app.tui.waitForText(`Do you want to update ${fileName}?`);
}

async function skipChangedFile(app: App, fileName: string): Promise<void> {
  await openDiffActions(app, fileName);
  await app.tui.user.down();
  await app.tui.user.enter();
}

async function reviewCapabilities(app: App): Promise<void> {
  await app.tui.waitForText("Configure capabilities");
  await app.tui.user.type("G");
  await app.tui.user.enter();
  await app.tui.waitForText("Review capabilities");
  await app.tui.user.enter();
}

async function selectNode(app: App): Promise<void> {
  await app.tui.waitForText("Configure capabilities");
  await app.tui.user.type("/nodejs");
  await app.tui.waitForText("Node.js + npm");
  await app.tui.user.enter();
  await app.tui.user.down(2);
  await app.tui.user.space();
  await app.tui.user.type("G");
  await app.tui.user.enter();
  await app.tui.waitForText("Review capabilities");
  await app.tui.user.enter();
}

async function initializeUser(app: App, tools = "node"): Promise<void> {
  const initialization = app.cli.run("init");
  await app.tui.waitForText("Select AI agents first");
  await app.tui.user.enter();
  await reviewCapabilities(app);
  expect((await initialization).exitCode).toBe(0);

  app.global.writeDockerfile(`# Tools: ${tools}\nFROM outdated\n`);
  const update = app.cli.run("config", "update");
  await openDiffActions(app, "docker/Dockerfile");
  await app.tui.user.enter();
  expect((await update).exitCode).toBe(0);
}

async function initializeProject(app: App, tools = "node"): Promise<void> {
  expect(
    (await app.cli.run("init", "--project", "--tools", tools)).exitCode,
  ).toBe(0);
}

describe("sandbox config update", () => {
  test("guides user and project workflows when no configuration exists", async () => {
    await using app = await setupSandboxAppTest();

    const user = await app.cli.run("config", "update");
    const project = await app.cli.run("config", "update", "--project");

    expect(user).toMatchObject({ exitCode: 0, stderr: "" });
    expect(user.stdout).toContain("No existing configuration found.");
    expect(user.stdout).toContain("Run sandbox init first.");
    expect(project).toMatchObject({ exitCode: 0, stderr: "" });
    expect(project.stdout).toContain("Run sandbox init --project first.");
  });

  test("uses known tool metadata and reports unknown tools", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig("custom = 'keep'\n");
    app.global.writeDockerfile("# Tools: node,retired-tool\nFROM old\n");

    const execution = app.cli.run("config", "update");
    await skipChangedFile(app, "config.toml");
    await skipChangedFile(app, "docker/Dockerfile");
    const result = await execution;

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Skipping unknown tool: retired-tool");
    expect(result.stdout).not.toContain("Configure capabilities");
    expect(app.workspace.readConfigFile("config.toml")).toBe(
      "custom = 'keep'\n",
    );
    expect(app.workspace.readConfigFile("docker/Dockerfile")).toContain(
      "# Tools: node,retired-tool",
    );
  });

  test("selects project tools when Dockerfile metadata is missing", async () => {
    await using app = await setupSandboxAppTest();
    app.project.writeDockerfile("FROM custom-base\n");

    const execution = app.cli.run("config", "update", "--project");
    await selectNode(app);
    await openDiffActions(app, "docker/Dockerfile");
    await app.tui.user.enter();
    const result = await execution;

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Could not detect tools from Dockerfile");
    expect(result.stdout).toContain("Select tools to regenerate Dockerfile");
    expect(app.workspace.readProjectFile(".sandbox/config.toml")).toContain(
      "Project-specific sandbox config",
    );
    const dockerfile = app.workspace.readProjectFile(
      ".sandbox/docker/Dockerfile",
    );
    expect(dockerfile).toContain("# Tools:");
    expect(dockerfile).not.toContain("FROM custom-base");
  });

  test("keeps current templates, persists hashes, and prints final guidance", async () => {
    await using app = await setupSandboxAppTest();
    await initializeUser(app);
    app.workspace.removeDataFile("sandbox/state.json");

    const result = await app.cli.run("config", "update");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Already up to date.");
    expect(result.stdout).toContain(
      "Done. Run sandbox build if any Dockerfile changed.",
    );
    const state = JSON.parse(
      app.workspace.readDataFile("sandbox/state.json"),
    ) as { templateHashes?: Record<string, string> };
    expect(Object.keys(state.templateHashes ?? {}).sort()).toEqual([
      "config",
      "dockerfile",
    ]);
  });

  test("accepts one changed project template and skips another", async () => {
    await using app = await setupSandboxAppTest();
    await initializeProject(app);
    app.project.writeConfig("custom = 'replace'\n");
    app.project.writeDockerfile("# Tools: node\nFROM keep-me\n");

    const execution = app.cli.run("config", "update", "--project");
    await openDiffActions(app, "config.toml");
    await app.tui.user.enter();
    await skipChangedFile(app, "docker/Dockerfile");
    const result = await execution;

    expect(result.exitCode).toBe(0);
    expect(app.workspace.readProjectFile(".sandbox/config.toml")).not.toContain(
      "custom = 'replace'",
    );
    expect(
      app.workspace.readProjectFile(".sandbox/docker/Dockerfile"),
    ).toContain("FROM keep-me");
  });

  test("cancels without changing the current file", async () => {
    await using app = await setupSandboxAppTest();
    await initializeProject(app);
    app.project.writeConfig("custom = 'cancelled'\n");

    const execution = app.cli.run("config", "update", "--project");
    await openDiffActions(app, "config.toml");
    await app.tui.user.chord("c", { ctrl: true });
    const result = await execution;

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Cancelled.");
    expect(app.workspace.readProjectFile(".sandbox/config.toml")).toBe(
      "custom = 'cancelled'\n",
    );
  });

  test("opens changed content in the selected editor", async () => {
    await using app = await setupSandboxAppTest();
    await initializeProject(app);
    app.project.writeConfig("custom = 'editor'\n");
    app.editor.givenAvailableEditors(["code"]);
    app.processes
      .expectStart({ match: { command: "code" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });

    const execution = app.cli.run("config", "update", "--project");
    await openDiffActions(app, "config.toml");
    await app.tui.waitForText("Open diff in VS Code");
    await app.tui.user.enter();
    const result = await execution;

    expect(result.exitCode).toBe(0);
    const launchedPaths = app.editor.launchedPaths();
    expect(launchedPaths).toContain(`${app.project.root}/.sandbox/config.toml`);
    expect(
      launchedPaths.some((filePath) => filePath.includes("sandbox-update-")),
    ).toBe(true);
    expect(app.workspace.readProjectFile(".sandbox/config.toml")).toBe(
      "custom = 'editor'\n",
    );
  });

  test("reports a generated-file write failure", async () => {
    await using app = await setupSandboxAppTest();
    await initializeUser(app);
    app.global.writeConfig("custom = 'write-failure'\n");
    app.editor.givenAvailableEditors([]);

    const execution = app.cli.run("config", "update");
    await openDiffActions(app, "config.toml");
    app.global.makeConfigWriteFail();
    await app.tui.user.enter();
    const result = await execution;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to write");
  });

  test("isolates parallel Git, hashes, settings, editors, files, and paths", async () => {
    await using first = await setupSandboxAppTest();
    await using second = await setupSandboxAppTest();
    first.workspace.git.givenRepository({
      root: first.workspace.root,
      queriedPath: first.project.root,
    });
    second.workspace.git.givenRepository({
      root: second.project.root,
      queriedPath: second.project.root,
    });
    await initializeProject(first, "node");
    await initializeProject(second, "php");
    await initializeUser(first, "node");
    await initializeUser(second, "php");
    first.global.givenSettings({ "owner.txt": "first" });
    second.global.givenSettings({ "owner.txt": "second" });
    first.global.writeConfig("custom = 'first'\n");
    second.global.writeConfig("custom = 'second'\n");
    first.editor.givenAvailableEditors(["code"]);
    second.editor.givenAvailableEditors(["idea"]);
    first.processes
      .expectStart({ match: { command: "code" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
    second.processes
      .expectStart({ match: { command: "idea" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });

    const firstExecution = first.cli.run("config", "update");
    const secondExecution = second.cli.run("config", "update");
    await Promise.all([
      openDiffActions(first, "config.toml"),
      openDiffActions(second, "config.toml"),
    ]);
    await Promise.all([
      first.tui.waitForText("Open diff in VS Code"),
      second.tui.waitForText("Open diff in IntelliJ IDEA"),
    ]);
    await Promise.all([first.tui.user.enter(), second.tui.user.enter()]);
    const [firstResult, secondResult] = await Promise.all([
      firstExecution,
      secondExecution,
    ]);

    expect(firstResult.exitCode).toBe(0);
    expect(secondResult.exitCode).toBe(0);
    expect(first.workspace.root).not.toBe(second.workspace.root);
    expect(first.workspace.git.operations()).not.toEqual(
      second.workspace.git.operations(),
    );
    expect(first.workspace.readConfigFile("settings/owner.txt")).toBe("first");
    expect(second.workspace.readConfigFile("settings/owner.txt")).toBe(
      "second",
    );
    expect(first.workspace.readConfigFile("docker/Dockerfile")).toContain(
      "# Tools: node",
    );
    expect(second.workspace.readConfigFile("docker/Dockerfile")).toContain(
      "# Tools: php",
    );
    expect(first.editor.launchedPaths()).not.toEqual(
      second.editor.launchedPaths(),
    );
    const firstState = first.workspace.readDataFile("sandbox/state.json");
    const secondState = second.workspace.readDataFile("sandbox/state.json");
    expect(firstState).not.toBe(secondState);
  });
});
