import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readDarwinJobProcesses } from "../../src/platform/foreground-job/darwin.js";
import { startPty } from "./utils/attached-session.js";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { getE2eRuntime } from "./utils/runtime.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "./utils/sandbox.js";

const macPodman = process.platform === "darwin" && getE2eRuntime() === "podman";

test.skipIf(!macPodman)(
  "reads native host identities in Bun and Node",
  async () => {
    const host = await readDarwinJobProcesses();
    expect(host.read(process.pid)).toMatchObject({
      pid: process.pid,
      uid: process.getuid?.(),
      realUid: process.getuid?.(),
      birth: expect.stringMatching(/^\d+:\d+$/u),
      pgid: expect.any(Number),
    });
    expect(host.read(2_147_483_647)).toBeNull();

    const adapter = new URL(
      "../../src/platform/foreground-job/darwin.ts",
      import.meta.url,
    ).href;
    const node = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "--eval",
        `
    import assert from 'node:assert/strict';
    import { readDarwinJobProcesses } from '${adapter}';
    const host = await readDarwinJobProcesses();
    assert.equal(host.read(process.pid)?.uid, process.getuid());
    assert.equal(host.read(2147483647), null);
  `,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    expect(await node.exited).toBe(0);
  },
);

const document = z.object({
  schemaVersion: z.literal(1),
  runtime: z.literal("podman"),
  attachment: z.object({
    state: z.enum(["starting", "attached", "not-found", "ambiguous"]),
    foregroundPgid: z.number(),
    sessionId: z.string().nullable(),
  }),
  containers: z.array(
    z.object({
      containerId: z.string().regex(/^[a-f0-9]{64}$/u),
      sessions: z.array(z.object({ id: z.string(), command: z.null() })),
    }),
  ),
});

async function readMarker(
  dir: string,
  name: string,
): Promise<string | undefined> {
  const file = Bun.file(join(dir, name));
  if (!(await file.exists())) return;
  return (await file.text()).trim() || undefined;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  failure: string,
): Promise<T> {
  const deadline = performance.now() + 30_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(100);
  } while (performance.now() < deadline);
  throw new Error(failure);
}

function launch(sb: SandboxInstance, label: string, wrapped = false) {
  const { binary, cwd, env } = sb.fixtureProcess;
  const pgidPath = join(sb.configDir, `${label}.pgid`);
  const command = [
    binary,
    "--no-build",
    "run",
    "--",
    "/bin/sh",
    "./guest.sh",
    label,
  ];
  const pty = startPty(
    wrapped
      ? [
          "/bin/sh",
          "-c",
          '"$@"; result=$?; exit "$result"',
          "wrapper",
          ...command,
        ]
      : command,
    { cwd, env },
    { pgidPath },
  );
  return Object.assign(pty, {
    async pgid() {
      const value = await waitFor(
        () => readMarker(sb.configDir, `${label}.pgid`),
        `No foreground PGID for ${label}`,
      );
      expect(value).toMatch(/^[1-9][0-9]*$/u);
      return Number(value);
    },
  });
}

test.skipIf(!macPodman)(
  "finds two pane jobs in one container and retires each attachment before its end hook",
  async () => {
    const project = await realpath(await createTempProject("foreground-jobs"));
    const observer = await realpath(
      await createTempProject("foreground-observer"),
    );
    let sb: SandboxInstance | undefined;
    try {
      for (const cwd of [project, observer]) {
        const git = Bun.spawnSync(["git", "init", "--quiet"], { cwd });
        expect(git.exitCode, git.stderr.toString()).toBe(0);
      }
      await writeProjectFile(
        project,
        ".sandbox/config.toml",
        `clipboard = "disabled"
[[hooks]]
event = "session.start"
command = ["/bin/sh", "./start.sh"]
wait = true
timeout = "60s"
[[hooks]]
event = "session.end"
command = ["/bin/sh", "./end.sh"]
wait = true
timeout = "60s"
`,
      );
      await writeProjectFile(
        project,
        "start.sh",
        `set -eu
printf '%s\\n' "$SANDBOX_SESSION_ID" > launch.pending
while [ ! -e allow-attach ]; do sleep 0.1; done
`,
      );
      await writeProjectFile(
        project,
        "guest.sh",
        `set -eu
test -t 0 && test -t 1
printf '%s\\n' "$SANDBOX_SESSION_ID" > "$1.attached"
while [ ! -e "$1.exit" ]; do sleep 0.1; done
`,
      );
      await writeProjectFile(
        project,
        "end.sh",
        `set -eu
id="$SANDBOX_SESSION_ID"
printf '%s\\n' "$id" > "$id.ending"
while [ ! -e "$id.end" ]; do sleep 0.1; done
`,
      );
      // Keep the test home isolated but let Podman find the actual machine configuration.
      const env = {
        XDG_CONFIG_HOME:
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        XDG_DATA_HOME:
          process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      };
      sb = createSandbox({ cwd: project, env });
      const observerSandbox = createSandbox({ cwd: observer, env });
      async function lookup(pgid: number) {
        const result = await observerSandbox.exec([
          "status",
          "--foreground-job",
          String(pgid),
          "--json",
        ]);
        assertSandboxSuccess(result);
        const status = document.parse(JSON.parse(result.stdout));
        expect(status.attachment.foregroundPgid).toBe(pgid);
        return status;
      }
      assertSandboxSuccess(await sb.build());
      await using first = launch(sb, "first", true);
      const firstGroup = await first.pgid();
      const firstId = await waitFor(
        () => readMarker(project, "launch.pending"),
        "The session start hook did not run",
      );
      expect(await lookup(firstGroup)).toMatchObject({
        attachment: { state: "starting", sessionId: firstId },
        containers: [],
      });
      await Bun.write(join(project, "allow-attach"), "");
      await waitFor(
        () => readMarker(project, "first.attached"),
        "The first guest session did not start",
      );
      await using second = launch(sb, "second");
      const secondGroup = await second.pgid();
      const secondId = await waitFor(
        () => readMarker(project, "second.attached"),
        "The second guest session did not start",
      );
      const firstResult = await lookup(firstGroup);
      const secondResult = await lookup(secondGroup);
      expect(firstId).not.toBe(secondId);
      expect(firstResult.attachment).toMatchObject({
        state: "attached",
        sessionId: firstId,
      });
      expect(secondResult.attachment).toMatchObject({
        state: "attached",
        sessionId: secondId,
      });
      expect(firstResult.containers).toEqual([
        {
          containerId: expect.any(String),
          sessions: [{ id: firstId, command: null }],
        },
      ]);
      const [firstContainer] = firstResult.containers;
      expect(secondResult.containers).toEqual([
        {
          containerId: firstContainer?.containerId ?? "missing",
          sessions: [{ id: secondId, command: null }],
        },
      ]);

      await Bun.write(join(project, "first.exit"), "");
      await waitFor(
        () => readMarker(project, `${firstId}.ending`),
        "The first session end hook did not run",
      );
      expect(first.status).toBeUndefined();
      expect((await lookup(firstGroup)).attachment.state).toBe("not-found");
      expect((await lookup(secondGroup)).attachment.state).toBe("attached");
      await Bun.write(join(project, `${firstId}.end`), "");
      expect(await first.result).toBe(0);

      second.send("C");
      await waitFor(
        () => readMarker(project, `${secondId}.ending`),
        "Closing the PTY did not run the end hook",
      );
      expect((await lookup(secondGroup)).attachment.state).toBe("not-found");
      await Bun.write(join(project, `${secondId}.end`), "");
      expect(await second.result).toBe(129);
    } finally {
      await cleanupProject(observer, undefined);
      await cleanupProject(project, sb);
    }
  },
  480_000,
);
