import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { requireCommandSuccess, runReleaseCommand } from "./release-command.js";
import { parseNpmPackReport } from "./release-package.js";

test("packs lifecycle-generated files even when prepare prints before the JSON report", async () => {
  const root = createTestDir("release-pack");
  using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "release-pack-fixture",
      version: "0.71.0",
      files: ["prepared.txt"],
      scripts: { prepare: "node prepare.cjs" },
    }),
  );
  await writeFile(
    path.join(root, "prepare.cjs"),
    'require("node:fs").writeFileSync("prepared.txt", "prepared"); process.stdout.write("[prepare] HUSKY=0 skip install");\n',
  );
  const result = runReleaseCommand("npm", ["pack", "--json"], root);
  const [report] = parseNpmPackReport(
    requireCommandSuccess("npm pack", result),
  );
  expect(await readFile(path.join(root, "prepared.txt"), "utf8")).toBe(
    "prepared",
  );
  expect(report?.files.some((file) => file.path === "prepared.txt")).toBe(true);
  expect(report?.integrity).toStartWith("sha512-");
});

test("rejects missing npm reports", () => {
  expect(() => parseNpmPackReport("Lifecycle command failed")).toThrow(
    "JSON package report",
  );
});
