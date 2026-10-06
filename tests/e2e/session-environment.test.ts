import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("session-environment");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    'env = ["HERDR_PANE_ID", "SESSION_IMAGE_DEFAULT"]\n',
  );
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    "FROM sandbox-base:latest\nENV SESSION_IMAGE_DEFAULT=image-default SANDBOX_IDLE_TIMEOUT_SECONDS=30\n",
  );
  await writeProjectFile(
    projectDir,
    "observe-environment.mjs",
    `import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";

const releasePath = "/tmp/session-environment-release";
const instancePath = "/tmp/session-environment-instance";
function report(phase) {
  console.log(JSON.stringify({
    phase,
    instanceMarker: readFileSync(instancePath, "utf8"),
    pane: process.env.HERDR_PANE_ID ?? null,
    imageDefault: process.env.SESSION_IMAGE_DEFAULT,
  }));
}
if (process.argv[2] === "hold") {
  writeFileSync(instancePath, randomUUID());
  const watcher = watch("/tmp", () => {
    if (!existsSync(releasePath)) return;
    watcher.close();
    report("released");
  });
  report("ready");
} else if (process.argv[2] === "release") {
  writeFileSync(releasePath, "release");
} else {
  report("session");
}
`,
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 120 });
  assertSandboxSuccess(await sb.build());
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

interface Observation {
  phase: string;
  instanceMarker: string;
  pane: string | null;
  imageDefault: string;
}

function observations(output: string): Observation[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

test("concurrent sessions share a container without sharing configured environment", async () => {
  const held = sb.start(
    ["--no-build", "run", "--", "node", "observe-environment.mjs", "hold"],
    {
      env: { HERDR_PANE_ID: "pane-A", SESSION_IMAGE_DEFAULT: "override-A" },
    },
  );
  await using release = new AsyncDisposableStack();
  release.defer(async () => {
    assertSandboxSuccess(
      await sb.exec([
        "--no-build",
        "run",
        "--",
        "node",
        "observe-environment.mjs",
        "release",
      ]),
    );
    assertSandboxSuccess(await held.result);
  });
  await held.waitForOutput('"phase":"ready"');

  const second = await sb.exec(
    ["--no-build", "run", "--", "node", "observe-environment.mjs"],
    {
      env: { HERDR_PANE_ID: "pane-B", SESSION_IMAGE_DEFAULT: "override-B" },
    },
  );
  assertSandboxSuccess(second);
  const secondObservation = observations(second.stdout)[0];
  if (!secondObservation)
    throw new Error(`Missing environment observation: ${second.stdout}`);
  expect(secondObservation).toMatchObject({
    pane: "pane-B",
    imageDefault: "override-B",
  });

  const omitted = await sb.exec(
    ["--no-build", "run", "--", "node", "observe-environment.mjs"],
    {
      env: { HERDR_PANE_ID: undefined, SESSION_IMAGE_DEFAULT: undefined },
    },
  );
  assertSandboxSuccess(omitted);
  expect(observations(omitted.stdout)[0]).toEqual({
    phase: "session",
    instanceMarker: secondObservation.instanceMarker,
    pane: null,
    imageDefault: "image-default",
  });

  await release.disposeAsync();
  const first = await held.result;
  const firstObservations = observations(first.stdout);
  expect(firstObservations).toEqual([
    {
      phase: "ready",
      instanceMarker: secondObservation.instanceMarker,
      pane: "pane-A",
      imageDefault: "override-A",
    },
    {
      phase: "released",
      instanceMarker: secondObservation.instanceMarker,
      pane: "pane-A",
      imageDefault: "override-A",
    },
  ]);
  expect(secondObservation.instanceMarker).not.toBe("");
}, 180_000);
