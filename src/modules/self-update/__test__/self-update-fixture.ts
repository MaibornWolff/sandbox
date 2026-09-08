import { createNpmFixture } from "#platform/npm/__test__/index.js";

export type SelfUpdateOperation =
  | { readonly type: "version.lookup"; readonly packageName: string }
  | { readonly type: "package.update"; readonly packageName: string }
  | {
      readonly type: "binary.run";
      readonly binaryName: string;
      readonly args: readonly string[];
    };

export interface SelfUpdateFixture {
  prepare(): void;
  givenPackageVersion(packageName: string, version: string): void;
  givenInstalledVersion(packageName: string, version: string): void;
  givenGlobalBinary(binaryName: string): void;
  failRegistry(packageName: string): void;
  failUpdate(packageName: string): void;
  installedVersion(packageName: string): string | null;
  operations(): readonly SelfUpdateOperation[];
}

export function createSelfUpdateFixture(
  processes: Parameters<typeof createNpmFixture>[0],
): SelfUpdateFixture {
  const npm = createNpmFixture(processes);
  return {
    prepare: () => npm.prepare(),
    givenPackageVersion: (packageName, version) =>
      npm.givenPackageVersion(packageName, version),
    givenInstalledVersion: (packageName, version) =>
      npm.givenInstalledVersion(packageName, version),
    givenGlobalBinary: (binaryName) => npm.givenGlobalBinary(binaryName),
    failRegistry: (packageName) => npm.failRegistry(packageName),
    failUpdate: (packageName) => npm.failUpdate(packageName),
    installedVersion: (packageName) => npm.installedVersion(packageName),
    operations: () => npm.operations(),
  };
}
