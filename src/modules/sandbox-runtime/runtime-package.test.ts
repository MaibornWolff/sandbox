import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { readRuntimePackage } from "./runtime-package.js";

test("rejects a partially built package until both programs are available", () => {
  const directory = createTestDir("runtime-package");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(directory));
  expect(() => readRuntimePackage(directory)).toThrow("Reinstall Sandbox");
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ version: "1.70.0" }),
  );
  for (const app of ["sandbox", "sandbox-container-tools"]) {
    const programDirectory = path.join(directory, "dist/apps", app);
    mkdirSync(programDirectory, { recursive: true });
    writeFileSync(
      path.join(programDirectory, "main.js"),
      "console.log('ready')",
    );
    if (app === "sandbox")
      expect(() => readRuntimePackage(directory)).toThrow("missing");
  }
  expect(readRuntimePackage(directory)).toMatchObject({
    directory,
    version: "1.70.0",
    contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});
