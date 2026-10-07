import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRepoRootPath } from "#platform/git/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let installation: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("runtime-package");
  installation = createTestDir("runtime-installation");
  const repoRoot =
    process.env.SANDBOX_RUNTIME_ROOT ?? (await getRepoRootPath(process.cwd()));
  const builtPackage = path.join(repoRoot, "dist/runtime");
  await cp(builtPackage, installation, { recursive: true });
  await cp(builtPackage, path.join(installation, "dist/runtime"), {
    recursive: true,
  });
  await chmod(path.join(installation, "dist/apps/sandbox/main.js"), 0o755);
  await writeFile(
    path.join(installation, "dist/runtime/release-marker.txt"),
    "first",
  );
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    `FROM sandbox-base:latest
RUN /usr/bin/node -e "require('node:fs').writeFileSync('/opt/tool-build-id', require('node:crypto').randomUUID())"
`,
  );
  sb = createSandbox({
    cwd: projectDir,
    binary: path.join(installation, "dist/apps/sandbox/main.js"),
    timeoutSeconds: 90,
  });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
  cleanupTestDir(installation);
}, 30_000);

const inspectRuntime = `
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const mount = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\\n')
  .map(line => line.split(' ')).find(fields => fields[4] === '/opt/sandbox-cli');
console.log(JSON.stringify({
  readOnly: mount?.[5].split(',').includes('ro') ?? false,
  cliVersion: execFileSync('sandbox', ['--version'], { encoding: 'utf8' }).trim(),
  toolsVersion: execFileSync('sandbox-container-tools', ['version'], { encoding: 'utf8' }).trim(),
  release: readFileSync('/opt/sandbox-cli/release-marker.txt', 'utf8'),
  toolBuild: readFileSync('/opt/tool-build-id', 'utf8'),
  hostInstallationVisible: existsSync(process.argv[1]),
}));
`;

test("updates the runtime cache without a tool-image rebuild or installation mount", async () => {
  expect((await sb.build()).exitCode).toBe(0);
  const hostVersion = await sb.exec(["--version"]);
  const first = await sb.run(
    "/usr/bin/node",
    "--input-type=module",
    "-e",
    inspectRuntime,
    installation,
  );
  expect(first.exitCode).toBe(0);
  const original = JSON.parse(first.stdout.trim());
  expect(original).toMatchObject({
    readOnly: true,
    cliVersion: hostVersion.stdout.trim(),
    toolsVersion: hostVersion.stdout.trim(),
    release: "first",
    hostInstallationVisible: false,
  });

  const releaseSignal = path.join(projectDir, "release-old-session");
  const oldSession = sb.start([
    "run",
    "--",
    "/usr/bin/node",
    "--input-type=module",
    "-e",
    `
import { existsSync, readFileSync } from 'node:fs';
console.log('old-session-ready');
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(releaseSignal)})) return;
  console.log('old-runtime=' + readFileSync('/opt/sandbox-cli/release-marker.txt', 'utf8'));
  clearInterval(timer);
}, 50);
`,
  ]);
  await oldSession.waitForOutput("old-session-ready");
  await writeFile(
    path.join(installation, "dist/runtime/release-marker.txt"),
    "second",
  );
  const updated = await sb.run(
    "/usr/bin/node",
    "--input-type=module",
    "-e",
    inspectRuntime,
    installation,
  );
  await writeFile(releaseSignal, "release");
  const oldResult = await oldSession.result;
  expect(updated.exitCode).toBe(0);
  expect(JSON.parse(updated.stdout.trim())).toEqual({
    ...original,
    release: "second",
  });
  expect(oldResult.exitCode).toBe(0);
  expect(oldResult.stdout).toContain("old-runtime=first");
}, 300_000);

test("concurrent starts use complete runtime contents", async () => {
  await writeFile(
    path.join(installation, "dist/runtime/release-marker.txt"),
    "concurrent",
  );
  const inspect = () =>
    sb.run(
      "/usr/bin/node",
      "--input-type=module",
      "-e",
      inspectRuntime,
      installation,
    );
  const results = await Promise.all([inspect(), inspect()]);
  for (const result of results) {
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      readOnly: true,
      release: "concurrent",
      hostInstallationVisible: false,
    });
  }
}, 120_000);
