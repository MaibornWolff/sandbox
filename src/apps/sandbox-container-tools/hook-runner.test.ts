import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HookConfig } from "#modules/configuration/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";

function startHook(
  root: string,
  hook: HookConfig,
  mode: "once" | "lease" = "once",
) {
  return Bun.spawn(
    [
      "node",
      path.join(root, "main.js"),
      "__run-hook",
      mode,
      JSON.stringify(hook),
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SANDBOX_EVENT: "caller-value",
        SANDBOX_SESSION_ID: "session-id",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    },
  );
}

function readResult(launcher: ReturnType<typeof startHook>) {
  return Promise.all([
    new Response(launcher.stdout).text(),
    new Response(launcher.stderr).text(),
    launcher.exited,
  ]);
}

function runHook(root: string, hook: HookConfig) {
  const launcher = startHook(root, hook);
  launcher.stdin.end();
  return readResult(launcher);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Guest process state did not change.");
}

function isRunning(pid: string): boolean {
  const statPath = `/proc/${pid}/stat`;
  try {
    const stat = readFileSync(statPath, "utf8");
    return (
      stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

// These cases require the guest's Linux process-group API and an unprivileged user.
describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "Node guest launcher",
  () => {
    let root: string;
    beforeAll(async () => {
      root = createTestDir("hook-runner");
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
      await Bun.build({
        entrypoints: [path.join(import.meta.dir, "main.ts")],
        outdir: root,
        target: "node",
        format: "esm",
        packages: "bundle",
        define: { SANDBOX_CONTAINER_TOOLS_VERSION: '"1.0.0"' },
      });
    });
    afterAll(() => cleanupTestDir(root));

    test("acknowledges spawn without waiting for completion or inheriting command output", async () => {
      const result = await runHook(root, {
        event: "session.start",
        wait: false,
        onError: "fail",
        timeoutMs: 3_500,
        command: [
          "node",
          "-e",
          `
        const fs = require('node:fs');
        console.log('discarded stdout');
        console.error('discarded stderr');
        const poll = setInterval(() => {
          if (!fs.existsSync('launcher-returned')) return;
          clearInterval(poll);
          fs.writeFileSync('detached-observed', JSON.stringify([process.env.SANDBOX_EVENT, process.env.SANDBOX_SESSION_ID, process.argv[1]]));
        }, 10);
      `,
          "a b;$(literal)",
        ],
      });
      expect(result).toEqual(["ok\n", "", 0]);
      writeFileSync(path.join(root, "launcher-returned"), "");
      const observed = path.join(root, "detached-observed");
      await waitFor(() => existsSync(observed));
      expect(JSON.parse(readFileSync(observed, "utf8"))).toEqual([
        "session.start",
        "session-id",
        "a b;$(literal)",
      ]);
    });

    test("does not acknowledge a missing executable and reports signal exit separately", async () => {
      expect(
        await runHook(root, {
          event: "session.start",
          wait: false,
          onError: "fail",
          command: ["/no-such-hook-runner-program"],
        }),
      ).toEqual(["spawn\n", "", 0]);
      expect(
        await runHook(root, {
          event: "session.start",
          wait: true,
          onError: "fail",
          command: ["node", "-e", "process.kill(process.pid, 'SIGTERM')"],
        }),
      ).toEqual(["signal:SIGTERM\n", "", 0]);
    });

    test("returns after a successful leased command without waiting for stdin to close", async () => {
      const launcher = startHook(
        root,
        {
          event: "session.start",
          wait: true,
          onError: "fail",
          command: ["node", "-e", ""],
        },
        "lease",
      );
      const [stdout, stderr, code] = await readResult(launcher);
      expect([stderr, code]).toEqual(["", 0]);
      expect(stdout.split("\n").at(-2)).toBe("ok");
    });

    test("stops a blocking hook without a deadline when its transport lease closes", async () => {
      const launcher = startHook(
        root,
        {
          event: "session.start",
          wait: true,
          onError: "fail",
          command: [
            "node",
            "-e",
            "require('node:fs').writeFileSync('lease-pid', String(process.pid)); setInterval(() => {}, 50);",
          ],
        },
        "lease",
      );
      const completion = readResult(launcher);
      const marker = path.join(root, "lease-pid");
      try {
        await waitFor(() => existsSync(marker));
      } finally {
        launcher.stdin.end();
      }
      const [stdout, stderr, code] = await completion;
      expect([stderr, code]).toEqual(["", 0]);
      expect(stdout.split("\n").at(-2)).toBe("cancelled");
      expect(isRunning(readFileSync(marker, "utf8"))).toBe(false);
    });

    test("times out and stops a TERM-resistant leader and its child", async () => {
      expect(
        await runHook(root, {
          event: "session.start",
          wait: true,
          onError: "fail",
          timeoutMs: 1_000,
          command: [
            "node",
            "-e",
            `
        const fs = require('node:fs');
        const { spawn } = require('node:child_process');
        process.on('SIGTERM', () => {});
        fs.writeFileSync('leader-pid', String(process.pid));
        spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('child-pid', String(process.pid)); setInterval(() => {}, 50);"]);
        setInterval(() => {}, 50);
      `,
          ],
        }),
      ).toEqual(["timeout\n", "", 0]);
      const leader = readFileSync(path.join(root, "leader-pid"), "utf8");
      const child = readFileSync(path.join(root, "child-pid"), "utf8");
      await waitFor(() => !isRunning(leader) && !isRunning(child));
    });
  },
);
