import * as fs from "node:fs";
import * as path from "node:path";
import { getRepoRootPath } from "../src/platform/git/index.js";

const MINIMUM_LINE_COVERAGE = 95;

function sumLcovField(source: string, field: "LF" | "LH"): number {
  const matches = source.matchAll(new RegExp(`^${field}:(\\d+)$`, "gm"));
  const values = [...matches].map((match) => Number(match[1]));
  if (values.length === 0) {
    throw new Error(`LCOV report contains no ${field} records.`);
  }
  return values.reduce((total, value) => total + value, 0);
}

export function calculateLineCoverage(source: string): number {
  const found = sumLcovField(source, "LF");
  const hit = sumLcovField(source, "LH");
  if (hit > found) throw new Error("LCOV lines hit exceeds lines found.");
  return found === 0 ? 100 : (hit / found) * 100;
}

if (import.meta.main) {
  const root = await getRepoRootPath(process.cwd());
  const reportPath = path.join(root, "coverage", "lcov.info");
  const coverage = calculateLineCoverage(fs.readFileSync(reportPath, "utf8"));
  console.log(`Aggregate line coverage: ${coverage.toFixed(2)}%`);
  if (coverage < MINIMUM_LINE_COVERAGE) {
    console.error(
      `Required line coverage: ${MINIMUM_LINE_COVERAGE.toFixed(2)}%`,
    );
    process.exitCode = 1;
  }
}
