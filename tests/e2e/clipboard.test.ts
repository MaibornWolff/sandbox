import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClipboardTestImage } from "#modules/clipboard/__test__/index.js";
import { getRepoRootPath } from "#platform/git/index.js";
import {
  assignConfiguredHostOwnership,
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let project: string;
let clipboard: string;
let sandbox: SandboxInstance;

beforeAll(async () => {
  project = await createTempProject("clipboard");
  clipboard = join(project, "clipboard-fixture");
  await mkdir(clipboard);
  await assignConfiguredHostOwnership(clipboard);
  await writeProjectFile(
    project,
    ".sandbox/config.toml",
    "allow_network = []\nsettings = []\n",
  );
  const root = await getRepoRootPath(process.cwd());
  const fixture = pathToFileURL(
    join(root, "src/apps/sandbox/__test__/clipboard-application.ts"),
  ).href;
  const executable = join(project, "controlled-sandbox.ts");
  await writeFile(
    executable,
    `#!/usr/bin/env bun\nimport "core-js/stable/disposable-stack/index.js";\nimport "core-js/stable/async-disposable-stack/index.js";\nimport { runClipboardTestApplication } from ${JSON.stringify(fixture)};\nprocess.exitCode = await runClipboardTestApplication({ directory: ${JSON.stringify(clipboard)}, argv: process.argv.slice(2), streams: { input: process.stdin, stdout: process.stdout, stderr: process.stderr } });\n`,
  );
  await chmod(executable, 0o755);
  sandbox = createSandbox({
    cwd: project,
    binary: executable,
    timeoutSeconds: 90,
  });
  const build = await sandbox.build(600);
  expect(build.exitCode).toBe(0);
}, 620_000);

afterAll(async () => {
  await cleanupProject(project, sandbox);
}, 45_000);

const payloads = {
  "text/plain": {
    initial: Buffer.from("Unicode 世界 🦊\n".repeat(30_000)),
    replacement: Buffer.from("new host content 🐈\n".repeat(20_000)),
    local: Buffer.from("container copy 世界\n".repeat(25_000)),
  },
  "image/png": {
    initial: createClipboardTestImage(512, 512),
    replacement: createClipboardTestImage(513, 512),
    local: createClipboardTestImage(514, 512),
  },
} as const;

describe("isolated automatic clipboard across the container boundary", () => {
  test.each(["text/plain", "image/png"] as const)(
    "serves fresh %s and publishes a complete large local selection",
    async (format) => {
      const { initial, replacement, local } = payloads[format];
      const continueFile = `continue-${format.replace("/", "-")}`;
      expect(initial.length).toBeGreaterThan(64 * 1024);
      await Promise.all([
        writeFile(join(clipboard, "input"), initial),
        writeFile(join(clipboard, "format"), format),
        writeFile(join(clipboard, "local"), local),
        rm(join(clipboard, "published-format"), { force: true }),
        rm(join(clipboard, continueFile), { force: true }),
      ]);
      const script = `set -eu
      test -n "$DISPLAY"
      test -f "$XAUTHORITY"
      test -z "\${WAYLAND_DISPLAY:-}"
      xclip -selection clipboard -o -t '${format}' > clipboard-fixture/first
      printf '%s\\n' "$DISPLAY" > clipboard-fixture/display-one
      printf 'first-paste-complete\\n'
      while [ ! -f clipboard-fixture/${continueFile} ]; do sleep 0.05; done
      xclip -selection clipboard -o -t '${format}' > clipboard-fixture/second
      xclip -selection clipboard -i -t '${format}' < clipboard-fixture/local
      i=0
      while [ "$(cat clipboard-fixture/published-format 2>/dev/null)" != '${format}' ]; do i=$((i + 1)); test "$i" -lt 200; sleep 0.05; done
      printf 'copy-complete\\n'
    `;
      const interaction = sandbox.start(["run", "--", "sh", "-c", script]);
      await interaction.waitForOutput("first-paste-complete", 60);
      expect((await readFile(join(clipboard, "first"))).equals(initial)).toBe(
        true,
      );
      const concurrent = await sandbox.run(
        "sh",
        "-c",
        'printf "%s\\n" "$DISPLAY" > clipboard-fixture/display-two',
      );
      expect(concurrent.exitCode, concurrent.stderr).toBe(0);
      const one = (
        await readFile(join(clipboard, "display-one"), "utf8")
      ).trim();
      const two = (
        await readFile(join(clipboard, "display-two"), "utf8")
      ).trim();
      expect(one).toMatch(/^:[0-9]+$/u);
      expect(two).toMatch(/^:[0-9]+$/u);
      expect(one).not.toBe(two);
      await writeFile(join(clipboard, "input"), replacement);
      await writeFile(join(clipboard, continueFile), "ready");
      const result = await interaction.result;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("copy-complete");
      expect(
        (await readFile(join(clipboard, "second"))).equals(replacement),
      ).toBe(true);
      expect((await readFile(join(clipboard, "input"))).equals(local)).toBe(
        true,
      );
      expect(await readFile(join(clipboard, "published-format"), "utf8")).toBe(
        format,
      );
    },
    120_000,
  );

  test("disables host clipboard transfers without stopping the command", async () => {
    const configPath = join(project, ".sandbox", "config.toml");
    const originalConfig = await readFile(configPath);
    const hostContent = Buffer.from("private host clipboard fixture");
    await Promise.all([
      writeFile(join(clipboard, "input"), hostContent),
      writeFile(join(clipboard, "format"), "text/plain"),
      writeFile(join(clipboard, "local"), "rejected container copy"),
    ]);
    await using restore = new AsyncDisposableStack();
    restore.defer(() => writeFile(configPath, originalConfig));
    await writeFile(
      configPath,
      'allow_network = []\nsettings = []\nclipboard = "disabled"\n',
    );
    const result = await sandbox.exec([
      "--no-build",
      "run",
      "--",
      "sh",
      "-c",
      `set -eu
      test -z "\${DISPLAY:-}"
      test -z "\${XAUTHORITY:-}"
      test -z "\${WAYLAND_DISPLAY:-}"
      test -n "$SANDBOX_HOST_BRIDGE_ENDPOINT"
      ! xclip -selection clipboard -o >/dev/null 2>&1
      ! xclip -selection clipboard -i < clipboard-fixture/local 2>/dev/null
      printf 'clipboard-disabled\\n'`,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("clipboard-disabled");
    expect((await readFile(join(clipboard, "input"))).equals(hostContent)).toBe(
      true,
    );
  }, 120_000);
});

const qualifyHost = process.env.SANDBOX_APPROVE_HOST_CLIPBOARD === "1";
(qualifyHost ? test : test.skip)(
  "approval-gated real host clipboard format discovery",
  async () => {
    const qualification = createSandbox({ cwd: project, timeoutSeconds: 90 });
    const result = await qualification.run(
      "sh",
      "-c",
      'test -n "$DISPLAY" && test -f "$XAUTHORITY" && xclip -selection clipboard -o -t TARGETS >/dev/null',
    );
    expect(result.exitCode).toBe(0);
  },
);
