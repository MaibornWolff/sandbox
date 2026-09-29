import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CycloneDxSbom,
  filterProductionSbom,
} from "./filter-production-sbom.js";

class PackageCommandError extends Error {
  constructor(
    readonly exitCode: number,
    command: string,
  ) {
    super(`${command} failed with exit code ${exitCode}`);
  }
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new PackageCommandError(result.status ?? 1, command);
  }
  return result.stdout;
}

async function preparePackage(): Promise<void> {
  const packageName = process.env.npm_package_name;
  const packageVersion = process.env.npm_package_version;
  const npmCli = process.env.npm_execpath;
  if (!packageName || !packageVersion || !npmCli) {
    throw new Error(
      "npm prepack requires package name, version, and npm CLI path",
    );
  }

  const temporaryDir = await mkdtemp(path.join(tmpdir(), "sandbox-package-"));
  await using _cleanup = {
    async [Symbol.asyncDispose]() {
      await rm(temporaryDir, { recursive: true, force: true });
    },
  };
  const licenseReport = path.join(temporaryDir, "licenses.json");
  console.error("Generating third-party notices for npm package");
  run(process.execPath, [
    "x",
    "license-checker@25.0.1",
    "--production",
    "--customPath",
    "scripts/license-report-format.json",
    "--json",
    "--out",
    licenseReport,
  ]);
  run(process.execPath, [
    "scripts/generate-third-party-notices.ts",
    licenseReport,
    "THIRD_PARTY_NOTICES.md",
    packageName,
    packageVersion,
  ]);
  console.error("Generating CycloneDX SBOM for npm package");
  const sbom = run(process.env.npm_node_execpath ?? "node", [
    npmCli,
    "sbom",
    "--sbom-format=cyclonedx",
  ]);
  const licenseData = JSON.parse(
    await readFile(licenseReport, "utf8"),
  ) as Record<string, { name: string; version: string }>;
  const productionSbom = filterProductionSbom(
    JSON.parse(sbom) as CycloneDxSbom,
    licenseData,
    packageName,
  );
  await writeFile(
    "SBOM.cdx.json",
    `${JSON.stringify(productionSbom, null, 2)}\n`,
  );
  console.error(`Wrote ${packageName}@${packageVersion} compliance files`);
}

if (import.meta.main)
  await preparePackage().catch((error: unknown) => {
    console.error(error);
    process.exitCode =
      error instanceof PackageCommandError ? error.exitCode : 1;
  });
