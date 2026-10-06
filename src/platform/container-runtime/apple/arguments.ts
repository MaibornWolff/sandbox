import type {
  ContainerMount,
  ContainerSpec,
  ExecSpec,
  TerminalSessionOptions,
} from "../container-contract.js";

const MINIMUM_APPLICATION_MEMORY_BYTES = 2 * 1024 ** 3;

export interface AppleCreateArgumentOptions {
  readonly allocateTerminal: boolean;
  readonly resolveMountSource: (mount: ContainerMount) => string;
  readonly dns?: string;
  readonly networkName?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

function pushEnvironment(
  args: string[],
  environment: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(environment)) {
    args.push("-e", `${key}=${value}`);
  }
}

function formatMount(
  mount: ContainerMount,
  resolveMountSource: (mount: ContainerMount) => string,
): string {
  return `${resolveMountSource(mount)}:${mount.targetPath}:${mount.readOnly ? "ro" : "rw"}`;
}

function formatPort(port: ContainerSpec["ports"][number]): string {
  const host = port.hostAddress ? `${port.hostAddress}:` : "";
  return `${host}${port.hostPort}:${port.containerPort}/${port.protocol}`;
}

export function buildAppleCreateArgs(
  spec: ContainerSpec,
  options: AppleCreateArgumentOptions,
): string[] {
  const args = ["create"];
  if (options.allocateTerminal) args.push("--tty");
  if (spec.removeOnExit) args.push("--rm");
  if (spec.init) args.push("--init");
  args.push("--name", spec.name);
  if (options.networkName) args.push("--network", options.networkName);
  if (options.dns) args.push("--dns", options.dns);
  for (const [key, value] of Object.entries(spec.labels)) {
    args.push("--label", `${key}=${value}`);
  }
  pushEnvironment(args, { ...spec.environment, ...options.environment });
  for (const mount of spec.mounts) {
    args.push("-v", formatMount(mount, options.resolveMountSource));
  }
  for (const port of spec.ports) args.push("-p", formatPort(port));
  for (const capability of spec.security.capabilities) {
    args.push("--cap-add", capability);
  }
  if (spec.security.dockerInDocker) {
    args.push("--masked-path", "NONE", "--read-only-path", "NONE");
  }
  const memoryBytes = Math.max(
    spec.resources.memoryBytes ?? 0,
    MINIMUM_APPLICATION_MEMORY_BYTES,
  );
  args.push("-m", String(memoryBytes));
  if (spec.resources.sharedMemorySize) {
    args.push("--shm-size", spec.resources.sharedMemorySize);
  }
  args.push("--ulimit", "nofile=65536:65536", spec.image);
  return args;
}

export function buildAppleStartArgs(
  id: string,
  session?: TerminalSessionOptions,
): string[] {
  const args = ["start"];
  if (session) args.push("--attach");
  if (session?.attachStdin) args.push("--interactive");
  args.push(id);
  return args;
}

export function buildAppleExecArgs(
  id: string,
  spec: ExecSpec,
  session?: TerminalSessionOptions,
): string[] {
  const args = ["exec"];
  if (session?.attachStdin) args.push("-i");
  if (session?.allocateTerminal) args.push("-t");
  if (spec.user) args.push("-u", spec.user);
  if (spec.workingDirectory) args.push("-w", spec.workingDirectory);
  pushEnvironment(args, spec.environment ?? {});
  args.push(id, ...spec.command);
  return args;
}
