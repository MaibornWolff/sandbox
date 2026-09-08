import { describe, expect, test } from "bun:test";
import {
  claudeCodeConfig,
  codexConfig,
  openCodeConfig,
} from "#test/fixtures/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir, stripAnsi } from "#test/utils.js";
import {
  displayBypassExplanation,
  displayFeatureOverview,
  displayInitAssistHint,
  displayReadyToGo,
  displaySeparator,
  displayWelcome,
} from "./initialization-display.js";

async function captureOutput(operation: () => void): Promise<string> {
  const root = createTestDir("workspace-display");
  try {
    const execution = await runInHostTestScope({ root }, operation);
    return stripAnsi(execution.stdout);
  } finally {
    cleanupTestDir(root);
  }
}

describe("init display", () => {
  test("renders welcome, overview, and separator", async () => {
    const output = await captureOutput(() => {
      displayWelcome();
      displayFeatureOverview();
      displaySeparator();
    });
    expect(output).toContain("Welcome to Sandbox");
    expect(output).toContain("How Sandbox Works");
  });

  test("prints the approved assist hint", async () => {
    const output = await captureOutput(displayInitAssistHint);
    expect(output).toContain(
      "Run sandbox assist to start an agent for customization, debugging, or questions.",
    );
  });

  test("orders useful commands", async () => {
    const output = await captureOutput(() => displayReadyToGo([]));
    const sandboxIndex = output.indexOf(
      "sandbox                Interactive shell in sandbox",
    );
    const assistIndex = output.indexOf("sandbox assist");
    const doctorIndex = output.indexOf("sandbox doctor");
    expect(assistIndex).toBeGreaterThan(sandboxIndex);
    expect(doctorIndex).toBeGreaterThan(assistIndex);
  });

  test("describes bypass behavior for supported agents", async () => {
    const output = await captureOutput(() =>
      displayBypassExplanation([claudeCodeConfig, codexConfig, openCodeConfig]),
    );
    expect(output).toContain("Claude Code");
    expect(output).toContain("Codex");
  });
});
