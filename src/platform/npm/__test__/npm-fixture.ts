import type { ProcessTestHarness } from "#platform/process/__test__/index.js";
import type { ProcessResult } from "#platform/process/index.js";

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const failed = (stderr: string, exitCode = 1) => ({
  exitCode,
  stdout: "",
  stderr,
});

export type NpmOperation =
  | { readonly type: "version.lookup"; readonly packageName: string }
  | { readonly type: "package.update"; readonly packageName: string }
  | {
      readonly type: "binary.run";
      readonly binaryName: string;
      readonly args: readonly string[];
    };

export interface NpmFixture {
  prepare(): void;
  givenPackageVersion(packageName: string, version: string): void;
  givenInstalledVersion(packageName: string, version: string): void;
  givenGlobalBinary(
    binaryName: string,
    result?: { readonly exitCode?: number; readonly stderr?: string },
  ): void;
  failRegistry(packageName: string, message?: string): void;
  failUpdate(packageName: string, message?: string): void;
  installedVersion(packageName: string): string | null;
  operations(): readonly NpmOperation[];
}

export function createNpmFixture(processes: ProcessTestHarness): NpmFixture {
  const packageVersions = new Map<string, string>();
  const installedVersions = new Map<string, string>();
  const registryResults = new Map<string, ProcessResult>();
  const updateResults = new Map<string, ProcessResult>();
  const binaryResults = new Map<string, ProcessResult>();

  function updateWasSuccessful(packageName: string): boolean {
    const result = updateResults.get(packageName);
    const args = ["install", "-g", `${packageName}@latest`];
    return (
      result?.exitCode === 0 &&
      processes.requests.some(
        (request) =>
          request.command === "npm" &&
          JSON.stringify(request.args ?? []) === JSON.stringify(args),
      )
    );
  }

  function arrange(
    command: string,
    args: readonly string[],
    result: ProcessResult,
  ): void {
    processes.expectStart({ match: { command, args } }).resolveResult(result);
  }

  return {
    prepare() {
      for (const [packageName, result] of registryResults) {
        arrange("npm", ["view", packageName, "version"], result);
      }
      for (const [packageName, result] of updateResults) {
        arrange("npm", ["install", "-g", `${packageName}@latest`], result);
      }
      for (const [binaryName, result] of binaryResults) {
        arrange(binaryName, ["config", "update"], result);
      }
    },
    givenPackageVersion(packageName, version) {
      packageVersions.set(packageName, version);
      registryResults.set(packageName, ok(`${version}\n`));
      updateResults.set(packageName, ok());
    },
    givenInstalledVersion(packageName, version) {
      installedVersions.set(packageName, version);
    },
    givenGlobalBinary(binaryName, result = {}) {
      binaryResults.set(
        binaryName,
        result.exitCode && result.exitCode !== 0
          ? failed(result.stderr ?? "binary failed", result.exitCode)
          : ok(),
      );
    },
    failRegistry(packageName, message = "npm ERR! code ENETUNREACH") {
      registryResults.set(packageName, failed(message));
    },
    failUpdate(packageName, message = "npm ERR! code EACCES") {
      updateResults.set(packageName, failed(message));
    },
    installedVersion(packageName) {
      if (updateWasSuccessful(packageName)) {
        return packageVersions.get(packageName) ?? null;
      }
      return installedVersions.get(packageName) ?? null;
    },
    operations() {
      return processes.requests.flatMap<NpmOperation>((request) => {
        const args = request.args ?? [];
        if (
          request.command === "npm" &&
          args[0] === "view" &&
          args[2] === "version"
        ) {
          return [{ type: "version.lookup", packageName: args[1] ?? "" }];
        }
        if (
          request.command === "npm" &&
          args[0] === "install" &&
          args[1] === "-g"
        ) {
          return [
            {
              type: "package.update",
              packageName: (args[2] ?? "").replace(/@latest$/, ""),
            },
          ];
        }
        if (binaryResults.has(request.command) && request.stdio === "inherit") {
          return [
            {
              type: "binary.run",
              binaryName: request.command,
              args: [...args],
            },
          ];
        }
        return [];
      });
    },
  };
}
