import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SOURCE_DIRECTORY = path.resolve(import.meta.dir, "..");

interface Finding {
  readonly line: number;
  readonly code: string;
  readonly reason: string;
}

const UNSAFE_REDACT_ARGS_JOIN_PATTERN =
  /redactCommandArgs\([^)]*\)\.join\(\s*["'] ["']\s*\)/;
const UNSAFE_REDACT_DOCKER_JOIN_PATTERN =
  /redactDockerCommand\([\s\S]{0,160}\.join\(\s*["'] ["']\s*\)[\s\S]{0,160}\)/;
const COMMAND_DEBUG_TERMS =
  /(Executing:|command:|build command|Foreground run|Exec command)/i;
const LOGGER_DEBUG_JOIN_PATTERN =
  /logger\.debug\([\s\S]*\.join\(\s*["'] ["']\s*\)[\s\S]*\)/;

function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function scanUnsafeCommandDisplayContent(content: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (UNSAFE_REDACT_ARGS_JOIN_PATTERN.test(line)) {
      findings.push({
        line: index + 1,
        code: line.trim(),
        reason:
          'redactCommandArgs().join(" ") bypasses redactCommandForDisplay()',
      });
    }
  }

  const dockerJoinMatch = content.match(UNSAFE_REDACT_DOCKER_JOIN_PATTERN);
  if (dockerJoinMatch?.index !== undefined) {
    findings.push({
      line: lineForIndex(content, dockerJoinMatch.index),
      code: dockerJoinMatch[0].trim().split("\n")[0] ?? "",
      reason: "redactDockerCommand() called on joined argv string",
    });
  }

  const debugJoinMatch = content.match(LOGGER_DEBUG_JOIN_PATTERN);
  if (
    debugJoinMatch?.index !== undefined &&
    COMMAND_DEBUG_TERMS.test(debugJoinMatch[0]) &&
    !debugJoinMatch[0].includes("redactCommandForDisplay(")
  ) {
    findings.push({
      line: lineForIndex(content, debugJoinMatch.index),
      code: debugJoinMatch[0].trim().split("\n")[0] ?? "",
      reason: "logger.debug() command display joins args directly",
    });
  }
  return findings;
}

function collectProductionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "__test__") {
      return collectProductionFiles(entryPath);
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      return [entryPath];
    }
    return [];
  });
}

describe("architecture: command display redaction", () => {
  test("production command displays use redactCommandForDisplay", () => {
    const violations = collectProductionFiles(SOURCE_DIRECTORY).flatMap(
      (file) =>
        scanUnsafeCommandDisplayContent(fs.readFileSync(file, "utf8")).map(
          (finding) => ({ file, ...finding }),
        ),
    );
    expect(violations).toEqual([]);
  });
});
