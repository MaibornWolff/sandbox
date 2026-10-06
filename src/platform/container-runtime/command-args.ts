import type {
  ContainerMount,
  ContainerSpec,
  ExecSpec,
  TerminalSessionOptions,
} from "./container-contract.js";

function formatMount(mount: ContainerMount): string {
  const source = mount.type === "bind" ? mount.sourcePath : mount.volumeName;
  return `${source}:${mount.targetPath}:${mount.readOnly ? "ro" : "rw"}`;
}

function formatPort(port: ContainerSpec["ports"][number]): string {
  const address = port.hostAddress ? `${port.hostAddress}:` : "";
  return `${address}${port.hostPort}:${port.containerPort}/${port.protocol}`;
}

function pushEnvironment(
  args: string[],
  environment: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(environment)) {
    args.push("-e", `${key}=${value}`);
  }
}

export function buildContainerRunArgs(
  spec: ContainerSpec,
  mode: "attached" | "detached",
  runtime: "apple-container" | "docker" | "podman",
): string[] {
  const args = ["run"];
  if (mode === "detached") args.push("-d");
  if (spec.removeOnExit) args.push("--rm");
  if (spec.init) args.push("--init");
  args.push("--name", spec.name);
  for (const [key, value] of Object.entries(spec.labels)) {
    args.push("--label", `${key}=${value}`);
  }
  pushEnvironment(args, spec.environment);
  for (const mount of spec.mounts) args.push("-v", formatMount(mount));
  for (const port of spec.ports) args.push("-p", formatPort(port));
  for (const capability of spec.security.capabilities) {
    args.push("--cap-add", capability);
  }
  if (runtime === "docker") {
    args.push("--add-host=host.docker.internal:host-gateway");
  }
  if (runtime === "podman") {
    args.push("--network=private", "--cgroups=disabled");
  }
  if (runtime !== "apple-container") {
    args.push(
      "--sysctl=net.ipv4.tcp_tw_reuse=1",
      "--sysctl=net.ipv4.ip_local_port_range=1024\t65535",
      "--sysctl=net.ipv4.tcp_fin_timeout=10",
    );
  }
  if (spec.resources.memoryBytes !== undefined) {
    args.push("--memory", String(spec.resources.memoryBytes));
  }
  if (spec.resources.sharedMemorySize) {
    args.push("--shm-size", spec.resources.sharedMemorySize);
  }
  if (
    runtime === "apple-container" &&
    spec.resources.memoryBytes === undefined
  ) {
    args.push("--memory", "2G");
  }
  args.push(
    "--ulimit",
    runtime === "podman" ? "nofile=65535:65535" : "nofile=65536:65536",
    spec.image,
  );
  return args;
}

export function buildContainerExecArgs(
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
