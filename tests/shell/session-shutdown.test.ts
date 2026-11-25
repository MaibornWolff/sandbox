import { expect, test } from "bun:test";
import path from "node:path";

test("the guest shutdown helper validates registration and stops only the tracked process", async () => {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-S",
      "-B",
      path.join(import.meta.dir, "fixtures/session-shutdown-test.py"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
});
