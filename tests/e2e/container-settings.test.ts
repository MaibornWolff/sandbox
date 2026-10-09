import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assignConfiguredHostOwnership,
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "./utils/sandbox.js";

const IDE_PORT = "23456";
let projectDir: string;
let mountedFile: string;
let copiedFile: string;
let sb: SandboxInstance;

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await Bun.sleep(250);
    }
  }
  const status = await sb.exec(["status"]);
  throw new Error(
    `Timed out waiting for settings backsync: ${filePath}\nsandbox status (exit code ${status.exitCode}):\n${status.stdout}\nstderr:\n${status.stderr}`,
  );
}

beforeAll(async () => {
  projectDir = await createTempProject("container-settings");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `settings = [
  "~/.phase11/**",
  { path = "~/.phase11-copy/config.toml", mode = "copy" },
]
`,
  );
  sb = createSandbox({
    cwd: projectDir,
    env: { CLAUDE_CODE_SSE_PORT: IDE_PORT },
  });
  const settingsRoot = join(sb.configDir, "settings");
  const mountedDirectory = join(settingsRoot, ".phase11");
  const copiedDirectory = join(settingsRoot, ".phase11-copy");
  await Promise.all([
    mkdir(mountedDirectory, { recursive: true }),
    mkdir(copiedDirectory, { recursive: true }),
  ]);
  mountedFile = join(mountedDirectory, "seeded.txt");
  copiedFile = join(copiedDirectory, "config.toml");
  await Promise.all([
    writeFile(mountedFile, "from-host", "utf8"),
    writeFile(copiedFile, 'model = "host-model"\n', "utf8"),
  ]);
  await chmod(mountedFile, 0o600);
  await assignConfiguredHostOwnership(settingsRoot);
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("container settings lifecycle", () => {
  test("mounts an existing host file read-write", async () => {
    const result = await sb.run(
      "sh",
      "-c",
      [
        'test "$(cat ~/.phase11/seeded.txt)" = "from-host"',
        'printf updated-from-container > "$HOME/.phase11/seeded.txt"',
      ].join("\n"),
    );

    assertSandboxSuccess(result);
    expect(await readFile(mountedFile, "utf8")).toBe("updated-from-container");
  }, 120_000);

  test("syncs a mount file that did not exist on the host", async () => {
    const result = await sb.run(
      "sh",
      "-c",
      `nc -z 127.0.0.1 ${IDE_PORT} && mkdir -p ~/.phase11 && printf synced > ~/.phase11/generated.txt`,
    );

    assertSandboxSuccess(result);
    const syncedFile = join(
      sb.configDir,
      "settings",
      ".phase11",
      "generated.txt",
    );
    expect(await waitForFile(syncedFile)).toBe("synced");
    if (process.getuid) {
      const expectedUid = Number(
        process.env.SANDBOX_HOST_UID ?? process.getuid(),
      );
      expect((await stat(syncedFile)).uid).toBe(expectedUid);
    }
  }, 120_000);

  test("copies an existing host file and restores it after atomic replacement", async () => {
    const replacement = await sb.run(
      "sh",
      "-c",
      [
        'test "$(cat ~/.phase11-copy/config.toml)" = \'model = "host-model"\'',
        "printf 'model = \"container-model\"\\n' > ~/.phase11-copy/config.toml.tmp",
        "mv ~/.phase11-copy/config.toml.tmp ~/.phase11-copy/config.toml",
        "cat ~/.phase11-copy/config.toml",
      ].join("\n"),
    );

    assertSandboxSuccess(replacement);
    expect(replacement.stdout).toContain('model = "container-model"');
    expect(await readFile(copiedFile, "utf8")).toBe('model = "host-model"\n');

    assertSandboxSuccess(await sb.stop());
    const restarted = await sb.run(
      "cat",
      "/home/sandbox/.phase11-copy/config.toml",
    );
    assertSandboxSuccess(restarted);
    expect(restarted.stdout).toBe('model = "host-model"\n');
  }, 120_000);
});
