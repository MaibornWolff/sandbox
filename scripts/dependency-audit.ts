import "core-js/stable/disposable-stack/index.js";
import "core-js/stable/async-disposable-stack/index.js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { z } from "zod";
import { getRepoRootPath } from "#platform/git/index.js";

const reportSchema = z.record(
  z.string(),
  z.array(
    z.object({
      title: z.string(),
      url: z.url(),
      severity: z.enum(["low", "moderate", "high", "critical"]),
      cwe: z.array(z.string()).optional(),
    }),
  ),
);

const denialOfServiceCwes = new Set([
  "CWE-400",
  "CWE-674",
  "CWE-770",
  "CWE-835",
  "CWE-1333",
]);

function isDenialOfService(
  advisory: z.infer<typeof reportSchema>[string][number],
): boolean {
  return advisory.cwe?.length
    ? advisory.cwe.every((cwe) => denialOfServiceCwes.has(cwe))
    : /denial[- ]of[- ]service|resource exhaustion|stack exhaustion/i.test(
        advisory.title,
      );
}

export function evaluateDependencyAudit(output: string, exitCode: number) {
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`Dependency audit failed with exit code ${exitCode}`);
  }
  const report = reportSchema.parse(JSON.parse(output));
  const advisories = Object.entries(report).flatMap(([name, entries]) =>
    entries.map((advisory) => ({ name, ...advisory })),
  );
  if (exitCode === 1 && advisories.length === 0) {
    throw new Error("Dependency audit failed without a vulnerability report");
  }
  const findings = advisories.filter(
    (advisory) => !isDenialOfService(advisory),
  );
  return {
    findings,
    blocked: findings.some((finding) => finding.severity === "critical"),
  };
}

async function main(): Promise<void> {
  const cwd = await getRepoRootPath(process.cwd());
  console.error(`Checking dependencies with ${chalk.cyan("bun audit")}`);
  const result = spawnSync("bun", ["audit", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.stderr) console.error(result.stderr.trim());
  const audit = evaluateDependencyAudit(result.stdout, result.status ?? 2);
  for (const finding of audit.findings) {
    const severity =
      finding.severity === "critical"
        ? chalk.red("Blocking: critical")
        : chalk.yellow(`Warning: ${finding.severity}`);
    console.error(
      `${severity} in ${chalk.cyan(finding.name)}: ${finding.title}\n${finding.url}`,
    );
  }
  if (audit.blocked) {
    console.error(
      "Critical dependency vulnerabilities block merging and publication",
    );
    process.exitCode = 1;
    return;
  }
  console.error(
    "No blocking dependency vulnerabilities. Denial-of-service advisories are ignored.",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
