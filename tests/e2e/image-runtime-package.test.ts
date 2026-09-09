import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("image-runtime-package");
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    "FROM sandbox-base:latest\nRUN /usr/local/bin/sandbox-container-tools version && sandbox --help\n",
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 60 });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

test("builds and starts with image-owned runtime files instead of a host package mount", async () => {
  const built = await sb.build();
  expect(built.exitCode).toBe(0);

  const hostVersion = await sb.exec(["--version"]);
  expect(hostVersion.exitCode).toBe(0);
  const result = await sb.run(
    "/usr/bin/node",
    "--input-type=module",
    "-e",
    `
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const mounts = readFileSync("/proc/self/mountinfo", "utf8")
  .trim().split("\\n").map(line => line.split(" ")[4]);
console.log(JSON.stringify({
  packageMounts: mounts.filter(target => target === "/opt/sandbox-cli" || target.startsWith("/opt/sandbox-cli/")),
  cliVersion: execFileSync("sandbox", ["--version"], { encoding: "utf8" }).trim(),
  toolsVersion: execFileSync("sandbox-container-tools", ["version"], { encoding: "utf8" }).trim(),
}));
`,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({
    packageMounts: [],
    cliVersion: hostVersion.stdout.trim(),
    toolsVersion: hostVersion.stdout.trim(),
  });
}, 300_000);
