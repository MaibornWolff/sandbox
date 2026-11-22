import { describe, expect, test } from "bun:test";
import {
  createSessionStatusFixture,
  type SessionStatusFixture,
} from "#modules/sandbox-containers/__test__/index.js";
import { ExecError } from "#platform/process/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import { stripAnsi } from "#test/utils.js";
import {
  type SandboxAppTest,
  setupSandboxAppTest,
} from "./__test__/sandbox-app-test.js";

const CLAUDE_SESSION_ID = "6f1c0d3e-9a4b-4c2d-8e7f-1a2b3c4d5e6f";
const SHELL_SESSION_ID = "a82b48cf-c10b-48ed-9fc4-193b80ef2856";
const CODEX_SESSION_ID = "c3d4e5f6-0a1b-4c2d-8e3f-4a5b6c7d8e9f";
const SIMILAR_SESSION_ID = "6f1c0d9a-0000-4000-8000-000000000000";

describe("sandbox status", () => {
  test("shows an empty project status", async () => {
    await using app = await setupSandboxAppTest();
    const result = await app.cli.run("status");
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Sandbox Status");
    expect(result.stdout).toContain("Runtime");
    expect(result.stdout).toContain("docker");
    expect(result.stdout).toContain("No active containers.");
  });

  test("shows running containers, uptime, hashes, and active sessions", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({
      state: "running",
      uptime: "Up 2 hours",
      hash: "abc123",
      sessions: [
        {
          pid: 43,
          startedAt: new Date("2026-01-01T00:05:00Z"),
          id: SHELL_SESSION_ID,
          command: ["zsh"],
        },
        {
          pid: 42,
          startedAt: new Date("2026-01-01T00:01:00Z"),
          id: CLAUDE_SESSION_ID,
          command: ["claude", "--resume", "fix the bug"],
          title: ["claude"],
        },
      ],
    });
    app.project.givenContainer({ state: "exited", uptime: "Exited" });

    const result = await app.cli.run("status");
    const stdout = stripAnsi(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("● sandbox-");
    expect(stdout).toContain("Up 2 hours");
    expect(stdout).toContain("abc123");
    expect(stdout).toContain("2 active");
    expect(stdout).toContain(
      "├ claude --resume 'fix the bug'  6f1c0d3e  (PID 42)\n",
    );
    expect(stdout).toContain("└ zsh  a82b48cf  (PID 43)\n");
    expect(stdout).not.toContain("Exited");
  });

  test("shows the process command line of a session with an older marker", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({
      state: "running",
      sessions: [{ pid: 361, title: ["pi"] }],
    });

    const result = await app.cli.run("status");

    expect(stripAnsi(result.stdout)).toContain("└ pi  (PID 361)\n");
  });

  test("marks a container without the ready marker as starting", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const { sessionStatus } = app.project.givenContainer({ state: "running" });
    sessionStatus.givenReady(false);

    const result = await app.cli.run("status");
    const stdout = stripAnsi(result.stdout);

    expect(stdout).toMatch(/◐ sandbox-\S+ {2}starting\n/u);
    expect(stdout).toContain("Sessions  none");
  });

  test("shows unknown sessions when the status probe fails", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const { sessionStatus } = app.project.givenContainer({ state: "running" });
    sessionStatus.fail(new Error("probe exec failed"));

    const result = await app.cli.run("--verbose", "status");
    const stdout = stripAnsi(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toMatch(/○ sandbox-\S+ {2}Up /u);
    expect(stdout).toContain("Sessions  unknown");
    expect(stripAnsi(result.stderr)).toContain(
      "Could not read the session status of sandbox-",
    );
    expect(result.stderr).toContain("probe exec failed");
  });

  test("runs one status probe as root for each running container", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const first = app.project.givenContainer({ state: "running" });
    const second = app.project.givenContainer({ state: "running" });
    app.project.givenContainer({ state: "exited" });

    const result = await app.cli.run("status");

    expect(stripAnsi(result.stdout).match(/Up 1 minute/g)).toHaveLength(2);
    const probes = app.runtime
      .events()
      .filter((event) => event.type === "container.exec")
      .map((event) => [event.containerId, event.options.user]);
    expect(probes.sort()).toEqual(
      [
        [first.id, "root"],
        [second.id, "root"],
      ].sort(),
    );
  });

  test("lists the containers once and inspects none of them", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({ state: "running" });
    app.project.givenContainer({ state: "running" });

    await app.cli.run("status");

    const types = app.runtime.events().map((event) => event.type);
    expect(types.filter((type) => type === "container.list")).toHaveLength(1);
    expect(types.filter((type) => type === "container.exec")).toHaveLength(2);
    expect(types).not.toContain("container.inspect");
  });

  test("shows only the containers of the current project without --all", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({ state: "running" });
    givenOtherProjectContainer(app, {
      name: "sandbox-other-aaaa",
      slug: "other-aaaa",
    });

    const result = await app.cli.run("status");
    const stdout = stripAnsi(result.stdout);

    expect(stdout).toContain("Project");
    expect(stdout).not.toContain("sandbox-other-aaaa");
    expect(stdout).not.toContain("all projects");
  });

  test("shows the containers of all projects grouped and sorted with --all", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({ state: "running" });
    givenOtherProjectContainer(app, {
      name: "sandbox-zeta-2",
      slug: "zeta-2222",
      dir: "/home/me/zeta",
    });
    givenOtherProjectContainer(app, {
      name: "sandbox-zeta-1",
      slug: "zeta-2222",
      dir: "/home/me/zeta",
    });
    givenOtherProjectContainer(app, {
      name: "sandbox-alpha",
      slug: "alpha-1111",
      dir: "/home/me/alpha",
    });
    givenOtherProjectContainer(app, {
      name: "sandbox-old",
      slug: "old-0000",
      status: "exited",
    });

    const result = await app.cli.run("status", "--all");
    const stdout = stripAnsi(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Sandbox Status · all projects");
    expect(stdout).not.toContain("sandbox-old");
    const order = [
      "alpha-1111  /home/me/alpha",
      "sandbox-alpha",
      "sandbox-zeta-1",
      "sandbox-zeta-2",
    ].map((text) => stdout.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(stdout.match(/zeta-2222 {2}\/home\/me\/zeta/g)).toHaveLength(1);
    expect(stdout).toContain(app.project.root);
    expect(stdout).toContain("Up 1 minute");
  });

  test("shows only the slug for a container without the folder label", async () => {
    await using app = await setupSandboxAppTest();
    givenOtherProjectContainer(app, {
      name: "sandbox-legacy",
      slug: "legacy-9999",
    });

    const result = await app.cli.run("status", "--all");

    expect(stripAnsi(result.stdout)).toMatch(/\n {2}legacy-9999\n/u);
  });

  test("preserves a runtime failure", async () => {
    await using failing = await setupSandboxAppTest();
    failing.runtime.system.fail("resolve", new Error("runtime failed"));
    const failed = await failing.cli.run("status");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("runtime failed");
  });

  test("exits with code 1 when the runtime command fails with another exit code", async () => {
    const message =
      "Command failed with exit code 125: Cannot connect to Podman.";
    for (const format of [[], ["--json"]]) {
      await using app = await setupSandboxAppTest();
      app.runtime.system.fail("container.list", new ExecError(message, 125));

      const result = await app.cli.run("--verbose", "status", ...format);
      const stderr = stripAnsi(result.stderr);

      expect(result).toMatchObject({ exitCode: 1, stdout: "" });
      expect(stderr).toContain(`\nError: ${message}\n`);
      expect(stderr).toContain(`Caused by: ExecError: ${message}`);
    }
  });

  test("shows status in an untrusted project with and without a terminal", async () => {
    for (const interactive of [true, false]) {
      await using app = await setupSandboxAppTest({ interactive });
      app.project.writeConfig("readonly = true\n");
      app.project.givenContainer({ state: "running" });

      const result = await app.cli.run("status");

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toContain("Up 1 minute");
      expect(app.tui.output()).not.toContain("Trust this project config?");
      expect(app.workspace.configFileExists("trusted-projects.json")).toBe(
        false,
      );
    }
  });

  test("shows the user runtime when the project config selects another runtime", async () => {
    await using app = await setupSandboxAppTest({ runtime: "podman" });
    app.global.writeConfig('runtime = "podman"\n');
    await app.project.givenConfig({ allowNetwork: [], runtime: "docker" });

    const result = await app.cli.run("status");

    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toMatch(/Runtime\s+podman/u);
    expect(app.runtime.resolvedConfigurations()).toEqual(["podman"]);
  });

  test("detects the runtime when only the project config selects a runtime", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [], runtime: "podman" });

    const result = await app.cli.run("status");

    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toMatch(/Runtime\s+docker/u);
    expect(app.runtime.resolvedConfigurations()).toEqual([undefined]);
  });

  test("fails with an invalid user config", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig('runtime = "unknown"\n');

    const result = await app.cli.run("status");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain(
      `Invalid config at ${app.workspace.configRoot}/config.toml`,
    );
    expect(app.runtime.resolvedConfigurations()).toEqual([]);
  });
});

describe("sandbox status --json", () => {
  test("prints the containers of the current project as JSON", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const { id: containerId } = app.project.givenContainer({
      state: "running",
      hash: "abc123",
      sessions: [
        {
          pid: 42,
          startedAt: new Date("2026-01-01T00:01:00Z"),
          id: CLAUDE_SESSION_ID,
          command: ["claude", "--resume", "fix the bug"],
          title: ["claude"],
        },
        { pid: 361, startedAt: new Date("2026-01-01T00:02:00Z") },
      ],
    });
    givenOtherProjectContainer(app, {
      name: "sandbox-other-aaaa",
      slug: "other-aaaa",
    });

    const result = await app.cli.run("status", "--json");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toEndWith("}\n");
    const slug = generateProjectSlug(app.project.root);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      runtime: "docker",
      containers: [
        {
          containerId,
          name: `sandbox-${slug}`,
          project: { slug, dir: app.project.root },
          image: `sandbox-${slug}:latest`,
          startedAt: "2025-12-31T23:59:00.000Z",
          ready: true,
          hash: "abc123",
          sessions: [
            {
              id: CLAUDE_SESSION_ID,
              pid: 42,
              startedAt: "2026-01-01T00:01:00.000Z",
              command: ["claude", "--resume", "fix the bug"],
            },
            {
              id: null,
              pid: 361,
              startedAt: "2026-01-01T00:02:00.000Z",
              command: null,
            },
          ],
        },
      ],
    });
  });

  test("prints an empty container list with the runtime", async () => {
    await using app = await setupSandboxAppTest();

    const result = await app.cli.run("status", "--json");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toBe(
      `${JSON.stringify({ schemaVersion: 1, runtime: "docker", containers: [] }, null, 2)}\n`,
    );
  });

  test("prints the containers of all projects with --all", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({ state: "running" });
    givenOtherProjectContainer(app, {
      name: "sandbox-alpha",
      slug: "alpha-1111",
      dir: "/home/me/alpha",
    });
    givenOtherProjectContainer(app, {
      name: "sandbox-legacy",
      slug: "legacy-9999",
    });

    const result = await app.cli.run("status", "--all", "--json");

    expect(result.exitCode).toBe(0);
    const slug = generateProjectSlug(app.project.root);
    expect(JSON.parse(result.stdout).containers).toMatchObject(
      [
        {
          name: "sandbox-alpha",
          project: { slug: "alpha-1111", dir: "/home/me/alpha" },
        },
        {
          name: "sandbox-legacy",
          project: { slug: "legacy-9999", dir: null },
        },
        {
          name: `sandbox-${slug}`,
          project: { slug, dir: app.project.root },
        },
      ].sort((left, right) =>
        left.project.slug.localeCompare(right.project.slug),
      ),
    );
  });

  test("keeps a container with unknown sessions when the probe fails", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const { sessionStatus } = app.project.givenContainer({ state: "running" });
    sessionStatus.fail(new Error("probe exec failed"));

    const result = await app.cli.run("--verbose", "status", "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("probe exec failed");
    expect(JSON.parse(result.stdout).containers).toMatchObject([
      { ready: null, sessions: null },
    ]);
  });

  test("prints nothing on stdout when the runtime is unreachable", async () => {
    await using app = await setupSandboxAppTest();
    app.runtime.system.fail("resolve", new Error("runtime failed"));

    const result = await app.cli.run("status", "--json");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain("Error: runtime failed");
  });

  test("prints the document in an untrusted project without a terminal", async () => {
    await using app = await setupSandboxAppTest({ interactive: false });
    app.project.writeConfig("readonly = true\n");
    app.project.givenContainer({ state: "running" });

    const result = await app.cli.run("status", "--json");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout).containers).toHaveLength(1);
    expect(app.workspace.configFileExists("trusted-projects.json")).toBe(false);
  });
});

describe("sandbox status --session", () => {
  async function givenSessions(): Promise<SandboxAppTest> {
    const app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({
      state: "running",
      sessions: [
        { pid: 42, id: CLAUDE_SESSION_ID, command: ["claude", "--resume"] },
        { pid: 43, id: SHELL_SESSION_ID, command: ["zsh"] },
        { pid: 361 },
      ],
    });
    givenOtherProjectContainer(app, {
      name: "sandbox-other-aaaa",
      slug: "other-aaaa",
      dir: "/home/me/other",
    }).givenSessions([{ pid: 7, id: CODEX_SESSION_ID, command: ["codex"] }]);
    return app;
  }

  test("shows only the matching session and its container in the text view", async () => {
    await using app = await givenSessions();

    const result = await app.cli.run("status", "--session", CLAUDE_SESSION_ID);
    const stdout = stripAnsi(result.stdout);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("Sandbox Status · session 6f1c0d3e");
    expect(stdout).toContain(
      `${generateProjectSlug(app.project.root)}  ${app.project.root}`,
    );
    expect(stdout).toContain("Sessions  1 active");
    expect(stdout).toContain("└ claude --resume  6f1c0d3e  (PID 42)\n");
    expect(stdout).not.toContain("a82b48cf");
    expect(stdout).not.toContain("PID 361");
    expect(stdout).not.toContain("sandbox-other-aaaa");
  });

  test("finds a session of another project by a unique prefix as JSON", async () => {
    await using app = await givenSessions();

    const result = await app.cli.run(
      "status",
      "--session",
      CODEX_SESSION_ID.slice(0, 6),
      "--json",
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      runtime: "docker",
      containers: [
        {
          containerId: app.runtime.instances.find("sandbox-other-aaaa")?.id,
          name: "sandbox-other-aaaa",
          project: { slug: "other-aaaa", dir: "/home/me/other" },
          image: "sandbox-base:latest",
          startedAt: "2025-12-31T23:59:00.000Z",
          ready: true,
          hash: null,
          sessions: [
            {
              id: CODEX_SESSION_ID,
              pid: 7,
              startedAt: "2026-01-01T00:00:00.000Z",
              command: ["codex"],
            },
          ],
        },
      ],
    });
  });

  test("gives the same result with --all", async () => {
    await using app = await givenSessions();

    const single = await app.cli.run(
      "status",
      "--session",
      SHELL_SESSION_ID,
      "--json",
    );
    const all = await app.cli.run(
      "status",
      "--all",
      "--session",
      SHELL_SESSION_ID,
      "--json",
    );

    expect(all).toEqual(single);
    expect(JSON.parse(all.stdout).containers).toMatchObject([
      { sessions: [{ id: SHELL_SESSION_ID }] },
    ]);
  });

  test.each([
    ["a short value", "6f1c0", "Use at least 6 characters of the session ID."],
    ["an unknown ID", "ffffffff", "No running session with ID ffffffff."],
    [
      "a prefix of more than one session",
      "6f1c0d",
      `More than one session ID starts with 6f1c0d: ${CLAUDE_SESSION_ID}, ${SIMILAR_SESSION_ID}. Use more characters.`,
    ],
  ])(
    "fails with %s and prints nothing on stdout",
    async (_name, value, message) => {
      await using app = await givenSessions();
      givenOtherProjectContainer(app, {
        name: "sandbox-similar",
        slug: "similar-bbbb",
      }).givenSessions([{ pid: 9, id: SIMILAR_SESSION_ID, command: ["pi"] }]);

      for (const format of [[], ["--json"]]) {
        const result = await app.cli.run(
          "status",
          "--session",
          value,
          ...format,
        );

        expect(result).toEqual({
          exitCode: 1,
          stdout: "",
          stderr: `${message}\n`,
        });
      }
    },
  );

  test("rejects a short value before it contacts the runtime", async () => {
    await using app = await setupSandboxAppTest();

    const result = await app.cli.run("status", "--session", "");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(app.runtime.resolvedConfigurations()).toEqual([]);
    expect(app.runtime.events()).toEqual([]);
  });

  test("names the containers of failed probes when the ID is unknown", async () => {
    await using app = await givenSessions();
    const broken = givenOtherProjectContainer(app, {
      name: "sandbox-broken",
      slug: "broken-cccc",
    });
    broken.fail(new Error("probe exec failed"));

    const unknown = await app.cli.run("status", "--session", "ffffffff");
    const found = await app.cli.run("status", "--session", CODEX_SESSION_ID);

    expect(unknown).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "No running session with ID ffffffff. Could not read the sessions of sandbox-broken.\n",
    });
    expect(found.exitCode).toBe(0);
    expect(stripAnsi(found.stdout)).toContain("└ codex  c3d4e5f6  (PID 7)");
  });
});

function givenOtherProjectContainer(
  app: SandboxAppTest,
  options: {
    readonly name: string;
    readonly slug: string;
    readonly dir?: string;
    readonly status?: "running" | "exited";
  },
): SessionStatusFixture {
  const container = app.runtime.instances.create({
    name: options.name,
    image: "sandbox-base:latest",
    labels: {
      "sandbox.project": options.slug,
      ...(options.dir ? { "sandbox.project-dir": options.dir } : {}),
    },
    status: options.status ?? "running",
    startedAt: new Date("2025-12-31T23:59:00Z"),
  });
  return createSessionStatusFixture(container);
}
