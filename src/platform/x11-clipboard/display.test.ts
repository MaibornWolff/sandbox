import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { observeDisplayLifetime, openDisplay } from "./display.js";

test("cleans private authentication files when Xvfb exits before readiness", async () => {
  await using resources = new AsyncDisposableStack();
  const time = createTestClock();
  resources.defer(() => time.dispose());
  const processes = createProcessTestHarness(time.clock);
  resources.use(processes.manager);
  const child = processes.expectStart({ match: { command: "Xvfb" } });
  const starting = openDisplay({
    processes: processes.manager,
    clock: time.clock,
    signal: new AbortController().signal,
  });
  const request = await child.waitForStart();
  const auth = request.args?.[(request.args?.indexOf("-auth") ?? -1) + 1];
  expect(auth).toBeDefined();
  if (!auth) throw new Error("Missing private authority path");
  const bytes = await readFile(auth);
  expect(bytes.readUInt16BE()).toBe(65535);
  child.exit({ exitCode: 42 });
  await expect(starting).rejects.toThrow(
    "Private X11 server exited before readiness",
  );
  await expect(access(auth)).rejects.toMatchObject({ code: "ENOENT" });
});

test("terminates an unready display on startup timeout", async () => {
  await using resources = new AsyncDisposableStack();
  const time = createTestClock();
  resources.defer(() => time.dispose());
  const processes = createProcessTestHarness(time.clock);
  resources.use(processes.manager);
  const child = processes.expectStart({ match: { command: "Xvfb" } });
  child.exitOnSignal();
  const starting = openDisplay({
    processes: processes.manager,
    clock: time.clock,
    signal: new AbortController().signal,
  });
  await child.waitForStart();
  await time.waitForSleep();
  await time.advanceBy(5_000);
  await expect(starting).rejects.toThrow("Private X11 operation timed out");
  expect(child.signals).toContain("SIGTERM");
});

for (const boundary of ["server", "connection"] as const) {
  test(`rejects unexpected ${boundary} termination after readiness`, async () => {
    const stopped = Promise.resolve();
    const pending = new Promise<void>(() => undefined);
    await expect(
      observeDisplayLifetime({
        process: boundary === "server" ? stopped : pending,
        connection: boundary === "connection" ? stopped : pending,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(`Private X11 ${boundary} stopped unexpectedly`);
  });
}

test("allows intentional shutdown without a display failure", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(
    observeDisplayLifetime({
      process: Promise.resolve(),
      connection: Promise.resolve(),
      signal: cancellation.signal,
    }),
  ).resolves.toBeUndefined();
});
