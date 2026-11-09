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
} else if (operation === "context") {
  console.log(JSON.stringify({
    sessionId: process.env.SANDBOX_SESSION_ID,
    projectDir: process.env.SANDBOX_PROJECT_DIR,
    container: process.env.SANDBOX_CONTAINER,
    runtime: process.env.SANDBOX_RUNTIME,
  }));
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
pattern = [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "context"]

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

  test("passes the session and resolved caller context to host commands", async () => {
    const result = await sb.exec(
      [
        "run",
        "--",
        "sh",
        "-c",
        `printf 'session:%s\\n' "$SANDBOX_SESSION_ID"; sandbox escape -- "$1" "$2" context`,
        "sh",
        process.execPath,
        fixturePath,
      ],
      {
        env: {
          SANDBOX_SESSION_ID: "inherited-session",
          SANDBOX_PROJECT_DIR: "inherited-project",
          SANDBOX_CONTAINER: "inherited-container",
          SANDBOX_RUNTIME: "inherited-runtime",
        },
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const sessionId = result.stdout.match(/session:([^\s]+)/)?.[1];
    const contextLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("{"));
    expect(contextLine).toBeDefined();
    const context = JSON.parse(contextLine ?? "{}");
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(context.sessionId).toBe(sessionId);
    expect(context.projectDir).toBe(projectDir);
    expect(context.container).toBeTruthy();
    expect(context.container).not.toBe("inherited-container");
    expect(["docker", "podman", "apple-container"]).toContain(context.runtime);
    const status = await sb.exec(["status"]);
    expect(status.exitCode).toBe(0);
    const resolvedRuntime = status.stdout.match(/^\s*Runtime\s+(\S+)/m)?.[1];
    expect(resolvedRuntime).toBeDefined();
    expect(context.runtime).toBe(resolvedRuntime);
    expect(status.stdout).toContain(context.container);
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
