interface ImageSetupActionOptions {
  readonly chownToContainerUser?: readonly string[];
}

interface ImageSetupActionBase {
  readonly chownToContainerUser: readonly string[];
}

export interface InstallAptPackagesAction extends ImageSetupActionBase {
  readonly kind: "install-apt-packages";
  readonly packages: readonly string[];
}

export interface InstallNpmPackagesAction extends ImageSetupActionBase {
  readonly kind: "install-npm-packages";
  readonly packages: readonly string[];
}

export interface InstallMiseToolsAction extends ImageSetupActionBase {
  readonly kind: "install-mise-tools";
  readonly tools: readonly string[];
}

export interface InstallGoPackagesAction extends ImageSetupActionBase {
  readonly kind: "install-go-packages";
  readonly packages: readonly string[];
}

export interface InstallCargoPackagesAction extends ImageSetupActionBase {
  readonly kind: "install-cargo-packages";
  readonly packages: readonly string[];
}

export interface RunImageSetupCommandsAction extends ImageSetupActionBase {
  readonly kind: "run-commands";
  readonly commands: readonly string[];
}

export interface AddDockerfileLinesAction extends ImageSetupActionBase {
  readonly kind: "add-dockerfile-lines";
  readonly lines: readonly string[];
}

export interface AddImagePathEntriesAction extends ImageSetupActionBase {
  readonly kind: "add-path-entries";
  readonly prepend: readonly string[];
  readonly append: readonly string[];
}

export interface AddShellSetupAction extends ImageSetupActionBase {
  readonly kind: "add-shell-setup";
  readonly lines: readonly string[];
}

export type ImageSetupAction =
  | InstallAptPackagesAction
  | InstallNpmPackagesAction
  | InstallMiseToolsAction
  | InstallGoPackagesAction
  | InstallCargoPackagesAction
  | RunImageSetupCommandsAction
  | AddDockerfileLinesAction
  | AddImagePathEntriesAction
  | AddShellSetupAction;

export interface ImageSetup {
  readonly asRoot?: readonly ImageSetupAction[];
  readonly asContainerUser?: readonly ImageSetupAction[];
}

function getChownToContainerUser(
  options?: ImageSetupActionOptions,
): readonly string[] {
  return options?.chownToContainerUser ?? [];
}

export function installAptPackages(
  packages: readonly string[],
  options?: ImageSetupActionOptions,
): InstallAptPackagesAction {
  return {
    kind: "install-apt-packages",
    packages,
    chownToContainerUser: getChownToContainerUser(options),
  };
}

export function installNpmPackages(
  packages: readonly string[],
  options?: ImageSetupActionOptions,
): InstallNpmPackagesAction {
  return {
    kind: "install-npm-packages",
    packages,
    chownToContainerUser: getChownToContainerUser(options),
  };
}

export function installMiseTools(
  tools: readonly string[],
  options?: ImageSetupActionOptions,
): InstallMiseToolsAction {
  return {
    kind: "install-mise-tools",
    tools,
    chownToContainerUser: getChownToContainerUser(options),
  };
}

/** @lintignore Public typed Go image setup action helper. */
export function installGoPackages(
  packages: readonly string[],
  options?: ImageSetupActionOptions,
): InstallGoPackagesAction {
  return {
    kind: "install-go-packages",
    packages,
    chownToContainerUser: getChownToContainerUser(options),
  };
}

/** @lintignore Public typed Cargo image setup action helper. */
export function installCargoPackages(
  packages: readonly string[],
  options?: ImageSetupActionOptions,
): InstallCargoPackagesAction {
  return {
    kind: "install-cargo-packages",
    packages,
    chownToContainerUser: getChownToContainerUser(options),
  };
}

export function runImageSetupCommands(
  commands: readonly string[],
  options?: ImageSetupActionOptions,
): RunImageSetupCommandsAction {
  return {
    kind: "run-commands",
    commands,
    chownToContainerUser: getChownToContainerUser(options),
  };
}

export function addDockerfileLines(
  lines: readonly string[],
  options?: ImageSetupActionOptions,
): AddDockerfileLinesAction {
  return {
    kind: "add-dockerfile-lines",
    lines,
    chownToContainerUser: getChownToContainerUser(options),
  };
}

export function addImagePathEntries(options: {
  readonly prepend?: readonly string[];
  readonly append?: readonly string[];
}): AddImagePathEntriesAction {
  return {
    kind: "add-path-entries",
    prepend: options.prepend ?? [],
    append: options.append ?? [],
    chownToContainerUser: [],
  };
}

export function addShellSetup(lines: readonly string[]): AddShellSetupAction {
  return { kind: "add-shell-setup", lines, chownToContainerUser: [] };
}
