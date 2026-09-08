import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { createEditorFixture, createTestTerminal } from "./__test__/index.js";
import {
  commandExists,
  getAvailableDiffEditors,
  getAvailableEditors,
  getEditorDiffCommand,
  openDiffInEditor,
  removeShadowedEditors,
} from "./editor.js";
import { provideTerminal } from "./terminal.js";

async function withEditorScope<T>(options: {
  readonly variables?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
  readonly run: (context: {
    readonly fixture: ReturnType<typeof createEditorFixture>;
    readonly terminal: ReturnType<typeof createTestTerminal>;
  }) => Promise<T>;
}): Promise<T> {
  const terminal = createTestTerminal();
  const processes = createProcessTestHarness();
  const platform = options.platform ?? "linux";
  const environment = createHostEnvironment({
    currentWorkingDirectory: "/workspace",
    homeDirectory: "/home/test",
    variables: options.variables ?? {},
    platform,
    interactive: true,
  });
  const fixture = createEditorFixture({
    processes,
    platform,
    environmentEditors: [
      ...(options.variables?.EDITOR ? [options.variables.EDITOR] : []),
      ...(options.variables?.VISUAL ? [options.variables.VISUAL] : []),
    ],
    cancel: () => terminal.abort(),
  });
  try {
    return await runWithDependencies(
      [
        provideHostEnvironment(environment),
        provideTerminal(terminal.io),
        provideProcessManager(processes.manager),
      ],
      () => options.run({ fixture, terminal }),
    );
  } finally {
    await terminal.dispose();
  }
}

describe("editor", () => {
  test("checks command availability through ProcessManager", async () => {
    await withEditorScope({
      async run({ fixture }) {
        fixture.givenAvailableEditors(["code"]);
        fixture.prepare();
        expect(await commandExists("code")).toBe(true);
        expect(await commandExists("idea")).toBe(false);
      },
    });
  });

  test("uses Windows command lookup through the scoped platform", async () => {
    await withEditorScope({
      platform: "win32",
      async run({ fixture }) {
        fixture.givenAvailableEditors(["code"]);
        fixture.prepare();
        expect(await commandExists("code")).toBe(true);
      },
    });
  });

  test("prioritizes scoped EDITOR and VISUAL values", async () => {
    await withEditorScope({
      variables: { EDITOR: "nvim", VISUAL: "code" },
      async run({ fixture }) {
        fixture.givenAvailableEditors(["nvim", "code"]);
        fixture.prepare();
        const editors = await getAvailableEditors();
        expect(editors.map((editor) => editor.command).slice(0, 2)).toEqual([
          "nvim",
          "code",
        ]);
      },
    });
  });

  test("filters and shadows available diff editors", async () => {
    await withEditorScope({
      async run({ fixture }) {
        fixture.givenAvailableEditors(["nvim", "vim", "vi", "code"]);
        fixture.prepare();
        const editors = await getAvailableDiffEditors();
        expect(editors.map((editor) => editor.command)).toEqual([
          "code",
          "nvim",
        ]);
      },
    });
  });

  test("builds stable diff commands", () => {
    expect(getEditorDiffCommand("/usr/bin/nvim")?.("a", "b")).toEqual([
      "nvim",
      "-d",
      "a",
      "b",
    ]);
    expect(getEditorDiffCommand("code")?.("a", "b")).toContain("--wait");
    expect(getEditorDiffCommand("nano")).toBeNull();
  });

  test("removes shadowed vi variants", () => {
    expect(
      removeShadowedEditors([
        { name: "nvim", command: "nvim" },
        { name: "vim", command: "vim" },
        { name: "vi", command: "vi" },
      ]),
    ).toEqual([{ name: "nvim", command: "nvim" }]);
  });

  test("launches blocking terminal and GUI editors through ProcessManager", async () => {
    await withEditorScope({
      async run({ fixture }) {
        fixture.givenLaunchResult({
          command: "nvim",
          existingPath: "current",
          updatedPath: "updated",
        });
        expect(await openDiffInEditor("current", "updated", "nvim")).toBe(true);
        fixture.givenLaunchResult({
          command: "code",
          existingPath: "current",
          updatedPath: "updated",
          stdout: "opened",
        });
        expect(await openDiffInEditor("current", "updated", "code")).toBe(true);
        fixture.acceptChanges("current");
        expect(fixture.acceptedChanges()).toEqual(["current"]);
        expect(fixture.output()).toEqual([
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "opened", stderr: "" },
        ]);
        expect(fixture.launchedPaths()).toEqual([
          "current",
          "updated",
          "current",
          "updated",
        ]);
      },
    });
  });

  test("launches non-waiting GUI editors detached", async () => {
    await withEditorScope({
      async run({ fixture }) {
        fixture.givenLaunchResult({
          command: "idea",
          existingPath: "current",
          updatedPath: "updated",
        });
        expect(await openDiffInEditor("current", "updated", "idea")).toBe(
          false,
        );
        expect(fixture.launchedPaths()).toEqual(["current", "updated"]);
      },
    });
  });

  test("preserves editor exit codes and cancellation", async () => {
    await withEditorScope({
      async run({ fixture }) {
        fixture.givenLaunchResult({
          command: "vim",
          existingPath: "a",
          updatedPath: "b",
          exitCode: 17,
          stderr: "failed",
        });
        await expect(openDiffInEditor("a", "b", "vim")).rejects.toMatchObject({
          exitCode: 17,
          stderr: "failed",
        });
        fixture.cancel();
        await expect(openDiffInEditor("a", "b", "vim")).rejects.toThrow();
      },
    });
  });
});
