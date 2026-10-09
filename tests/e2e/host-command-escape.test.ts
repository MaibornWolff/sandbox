import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let fixturePath: string;
let effectPath: string;
let cleanupPath: string;
let disposalPath: string;
let sb: SandboxInstance;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

beforeAll(async () => {
  projectDir = await createTempProject("host-command-escape");
  fixturePath = join(projectDir, "host-command-fixture.mjs");
  effectPath = join(projectDir, "denied-effect.txt");
  cleanupPath = join(projectDir, "escaped-child-stopped.txt");
  disposalPath = join(projectDir, "disposed-child-stopped.txt");
  await writeProjectFile(
    projectDir,
    "host-command-fixture.mjs",
    `import { readFileSync, writeFileSync } from "node:fs";

const [operation, ...targets] = process.argv.slice(2);
const target = targets[0];
if (operation === "io") {
  const input = readFileSync(0, "utf8");
  process.stdout.write(\`stdout:\${input}\`);
  process.stderr.write("stderr:separate\\n");
} else if (operation === "exit") {
  process.exit(Number(target));
} else if (operation === "effect") {
  writeFileSync(target, "created");
} else if (operation === "hold") {
  process.stdout.write("holding\\n");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      writeFileSync(target, signal);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  setInterval(() => undefined, 1000);
}
`,
  );
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `[[allow_host_commands]]
pattern = [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "io"]

[[allow_host_commands]]
pattern = [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "exit", "47"]

[[allow_host_commands]]
pattern = [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "hold", [${tomlString(cleanupPath)}, ${tomlString(disposalPath)}]]
`,
  );
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    "FROM sandbox-base:latest\nENV SANDBOX_IDLE_TIMEOUT_SECONDS=30\n",
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 40 });
  expect((await sb.build()).exitCode).toBe(0);
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("host command escape", () => {
  test("streams through the filtered container network and preserves exit behavior", async () => {
    const streams = await sb.exec(
      [
        "run",
        "--",
        "sandbox",
        "escape",
        "--",
        process.execPath,
        fixturePath,
        "io",
      ],
      { stdin: "input-data\n" },
    );
    expect(streams.exitCode).toBe(0);
    expect(streams.stdout).toContain("stdout:input-data");
    expect(streams.stderr).toContain("stderr:separate");
    expect(streams.stdout).not.toContain("stderr:separate");

    const exited = await sb.run(
      "sandbox",
      "escape",
      "--",
      process.execPath,
      fixturePath,
      "exit",
      "47",
    );
    expect(exited.exitCode).toBe(47);
  });

  test("denies unmatched commands before they can create a host effect", async () => {
    const denied = await sb.run(
      "sandbox",
      "escape",
      "--",
      process.execPath,
      fixturePath,
      "effect",
      effectPath,
    );

    expect(denied.exitCode).toBe(126);
    expect(denied.stderr).toContain("command is not allowed");
    expect(existsSync(effectPath)).toBe(false);
  });

  test("stops an active escaped child when the outer session completes", async () => {
    const outputPath = join(projectDir, "background-escape-output.txt");
    const completed = await sb.run(
      "sh",
      "-c",
      `sandbox escape -- ${process.execPath} ${fixturePath} hold ${disposalPath} > ${outputPath} 2>&1 & while ! grep -q holding ${outputPath}; do sleep 0.05; done`,
    );
    expect(completed.exitCode).toBe(0);

    const deadline = Date.now() + 5_000;
    while (!existsSync(disposalPath) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(readFileSync(disposalPath, "utf8")).toBe("SIGTERM");
  });

  test("forwards SIGINT to an active escaped child", async () => {
    const interaction = sb.start([
      "run",
      "--",
      "sandbox",
      "escape",
      "--",
      process.execPath,
      fixturePath,
      "hold",
      cleanupPath,
    ]);
    await interaction.waitForOutput("holding");
    interaction.sendSignal("SIGINT");
    await interaction.result;

    const deadline = Date.now() + 5_000;
    while (!existsSync(cleanupPath) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(readFileSync(cleanupPath, "utf8")).toBe("SIGINT");
  });
});
