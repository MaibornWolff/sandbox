import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  createHostGitFixture,
  runInHostTestScope,
} from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { assistCommand } from "./assist-command.js";

async function runAssist(options: {
  readonly agent: string;
  readonly question?: string;
  readonly launchResult?: { readonly exitCode: number };
  readonly launchFailure?: Error;
}) {
  const root = createTestDir("assist-command");
  const result = await runInHostTestScope({ root }, ({ processes }) => {
    createHostGitFixture(processes).givenNoRepository(root);
    const launch = processes.expectStart({
      match: { command: options.agent },
    });
    if (options.launchFailure) launch.rejectResult(options.launchFailure);
    else if (options.launchResult) {
      launch.resolveResult({
        ...options.launchResult,
        stdout: "",
        stderr: "",
      });
    }
    return assistCommand({
      agent: options.agent,
      ...(options.question ? { question: options.question } : {}),
    });
  });
  return { root, ...result };
}

describe("assistCommand", () => {
  test("launches an automatic agent, preserves its exit code, and cleans context", async () => {
    const observed = await runAssist({
      agent: "codex",
      question: "How do I add Node?",
      launchResult: { exitCode: 7 },
    });
    try {
      const launch = observed.processes.requests.find(
        (request) => request.command === "codex",
      );
      expect(observed.result).toBe(7);
      expect(launch?.args?.[0]).toContain("How do I add Node?");
      const contextPath = launch?.args?.[0]?.match(
        /\S*sandbox-assist-context\.md/,
      )?.[0];
      expect(contextPath).toBeDefined();
      expect(fs.existsSync(contextPath as string)).toBe(false);
    } finally {
      cleanupTestDir(observed.root);
    }
  });

  test("keeps context for agents that require manual startup", async () => {
    const observed = await runAssist({ agent: "copilot" });
    try {
      const output = stripVTControlCharacters(observed.stdout);
      const contextPath = output.match(
        /Sandbox context written to ([^\n]+)\./,
      )?.[1];
      expect(observed.result).toBe(0);
      expect(output).toContain("does not support automatic");
      expect(contextPath).toBeDefined();
      expect(fs.readFileSync(contextPath as string, "utf8")).toContain(
        "Sandbox configuration assistant",
      );
      expect(
        observed.processes.requests.some(
          (request) => request.command === "copilot",
        ),
      ).toBe(false);
      fs.rmSync(path.dirname(contextPath as string), {
        recursive: true,
        force: true,
      });
    } finally {
      cleanupTestDir(observed.root);
    }
  });

  test("reports launch errors and returns a failing exit code", async () => {
    const observed = await runAssist({
      agent: "claude",
      launchFailure: new Error("command not found"),
    });
    try {
      expect(observed.result).toBe(1);
      expect(stripVTControlCharacters(observed.stderr)).toContain(
        "Failed to launch claude: command not found",
      );
    } finally {
      cleanupTestDir(observed.root);
    }
  });
});
