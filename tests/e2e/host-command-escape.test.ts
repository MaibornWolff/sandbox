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
let openInvocationPath: string;
let sb: SandboxInstance;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function readOpenInvocations(): string[] {
  return existsSync(openInvocationPath)
    ? readFileSync(openInvocationPath, "utf8").trim().split("\n")
    : [];
}

beforeAll(async () => {
  projectDir = await createTempProject("host-command-escape");
  fixturePath = join(projectDir, "host-command-fixture.mjs");
  effectPath = join(projectDir, "denied-effect.txt");
  cleanupPath = join(projectDir, "escaped-child-stopped.txt");
  disposalPath = join(projectDir, "disposed-child-stopped.txt");
  openInvocationPath = join(projectDir, "open-invocations.txt");
  await writeProjectFile(
    projectDir,
    "host-command-fixture.mjs",
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

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
} else if (operation === "open") {
  appendFileSync(${JSON.stringify(openInvocationPath)}, \`\${JSON.stringify(targets)}\\n\`);
  process.stdout.write(\`opened:\${targets.join("|")}\\n\`);
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

[[allow_host_commands]]
pattern = [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "open", { repeat = [{ regex = 'https?://\\S+' }, { regex = '[^-:][^:]*\\.html?', flags = "i" }], min = 1, max = 10 }]
test_match = [
  [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "open", "report.html"],
  [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "open", "http://example.com"],
  [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "open", "https://example.com"],
]
test_no_match = [
  [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "open"],
  [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "open", "-a", "Terminal"],
  [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "open", "/Applications/Calculator.app"],
  [${tomlString(process.execPath)}, ${tomlString(fixturePath)}, "open", "file:///tmp/report.html"],
]
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
  test("lists the canonical effective rules without a heading", async () => {
    const result = await sb.run("sandbox", "escape", "--list");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      JSON.stringify([process.execPath, fixturePath, "io"]),
      JSON.stringify([process.execPath, fixturePath, "exit", "47"]),
      JSON.stringify([
        process.execPath,
        fixturePath,
        "hold",
        [cleanupPath, disposalPath],
      ]),
      JSON.stringify([
        process.execPath,
        fixturePath,
        "open",
        {
          repeat: [
            { regex: "https?://\\S+" },
            { regex: "[^-:][^:]*\\.html?", flags: "i" },
          ],
          min: 1,
          max: 10,
        },
      ]),
    ]);
  });

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

  test("allows HTML and web targets through a structured repetition rule", async () => {
    for (const target of [
      "report.HTML",
      "http://example.com/report",
      "https://example.com/report",
    ]) {
      const result = await sb.run(
        "sandbox",
        "escape",
        "--",
        process.execPath,
        fixturePath,
        "open",
        target,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`opened:${target}`);
    }

    expect(readOpenInvocations()).toEqual([
      '["report.HTML"]',
      '["http://example.com/report"]',
      '["https://example.com/report"]',
    ]);
  });

  test("rejects unsafe open targets and trailing arguments before host process creation", async () => {
    const previousInvocations = readOpenInvocations();
    const rejectedArguments = [
      ["/Applications/Calculator.app"],
      ["file:///tmp/report.html"],
      ["-a", "Terminal"],
    ];

    for (const arguments_ of rejectedArguments) {
      const denied = await sb.run(
        "sandbox",
        "escape",
        "--",
        process.execPath,
        fixturePath,
        "open",
        ...arguments_,
      );
      expect(denied.exitCode).toBe(126);
      expect(denied.stderr).toContain("command is not allowed");
    }

    const trailing = await sb.run(
      "sandbox",
      "escape",
      "--",
      process.execPath,
      fixturePath,
      "io",
      "unexpected",
    );
    expect(trailing.exitCode).toBe(126);
    expect(trailing.stderr).toContain("command is not allowed");
    expect(readOpenInvocations()).toEqual(previousInvocations);
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

  test("invalidates old session data after the outer execution ends", async () => {
    const saved = await sb.run(
      "sh",
      "-c",
      `printf "export SANDBOX_HOST_BRIDGE_ENDPOINT='%s'\\nexport SANDBOX_HOST_BRIDGE_TOKEN='%s'\\nexport SANDBOX_HOST_BRIDGE_CERTIFICATE='%s'\\n" "$SANDBOX_HOST_BRIDGE_ENDPOINT" "$SANDBOX_HOST_BRIDGE_TOKEN" "$SANDBOX_HOST_BRIDGE_CERTIFICATE" > .stale-escape-session`,
    );
    expect(saved.exitCode).toBe(0);

    const stale = await sb.run(
      "sh",
      "-c",
      ". ./.stale-escape-session && sandbox escape --list",
    );
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr).toContain("sandbox escape:");
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

  test("forwards Ctrl-C to an active escaped child", async () => {
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
