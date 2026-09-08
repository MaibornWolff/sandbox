import type { CreateContainerOptions, ImageBuildOptions } from "./types.js";

interface BuildImageArgsOptions {
  includeLoad?: boolean;
  includeSecrets?: boolean;
}

function pushLabelsAndExtraArgs(
  args: string[],
  options: { labels?: Record<string, string>; extraArgs?: string[] },
): void {
  if (options.labels) {
    for (const [key, value] of Object.entries(options.labels)) {
      args.push("--label", `${key}=${value}`);
    }
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
}

export function buildCreateContainerArgs(
  options: CreateContainerOptions,
): string[] {
  const args = ["run", "-d"];
  if (options.autoRemove !== false) {
    args.push("--rm");
  }
  args.push("--init", "--name", options.name);
  pushLabelsAndExtraArgs(args, options);
  args.push(options.image);
  return args;
}

export function buildImageBuildArgs(
  options: ImageBuildOptions,
  config: BuildImageArgsOptions = {},
): string[] {
  const args = ["build"];

  if (config.includeLoad) {
    args.push("--load");
  }

  if (options.noCache) args.push("--no-cache");

  if (options.buildArgs) {
    for (const [key, value] of Object.entries(options.buildArgs)) {
      args.push("--build-arg", `${key}=${value}`);
    }
  }

  if (config.includeSecrets && options.secrets) {
    for (const secret of options.secrets) {
      args.push("--secret", `id=${secret.id},env=${secret.env}`);
    }
  }

  pushLabelsAndExtraArgs(args, options);

  args.push("-t", options.tag);
  args.push("-f", options.dockerfilePath);
  args.push(options.contextDir);
  return args;
}

export function buildCopyVolumeArgs(source: string, target: string): string[] {
  return [
    "run",
    "--rm",
    "-v",
    `${source}:/from`,
    "-v",
    `${target}:/to`,
    "alpine",
    "sh",
    "-c",
    "cp -a /from/. /to/",
  ];
}
