import * as fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { type Clock, getClock } from "#platform/clock/index.js";
import {
  getSandboxEnvironment,
  type SandboxEnvironment,
} from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  getProcessManager,
  type ManagedProcess,
  type ProcessManager,
  type ProcessResult,
} from "#platform/process/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { executeContainerCommand } from "./command.js";
import { restoreFirewall } from "./firewall.js";
import { getTcpService, type TcpService } from "./tcp-service.js";

type ManagedNetworkProcess = ManagedProcess<ProcessResult>;

/** @lintignore Public Squid domain ACL file contract. */
export interface SquidDomainAclGroup {
  readonly id: number;
  readonly content: string;
}

export function getSquidDomainAclPath(groupId: number): string {
  return `/var/run/proxy-allowed-domains-${groupId}.txt`;
}

/** @lintignore Public container network system boundary. */
export interface ContainerNetworkSystem {
  readonly failure: Promise<Error>;
  readonly applyFirewall: (
    commands: readonly (readonly string[])[],
  ) => Promise<void>;
  readonly applyIpv6Firewall: (
    commands: readonly (readonly string[])[],
  ) => Promise<void>;
  readonly applyHostMappings: (
    mappings: readonly { readonly host: string; readonly address: string }[],
  ) => Promise<void>;
  readonly discoverUpstreamDns: () => Promise<string>;
  readonly startDnsmasq: (options: {
    readonly config: string;
  }) => Promise<void>;
  readonly startSquid: (options: {
    readonly config: string;
    readonly domainAclGroups?: readonly SquidDomainAclGroup[];
    readonly blockedErrorPage?: string;
  }) => Promise<void>;
  readonly startNetworkTrace: () => Promise<void>;
}

const IPTABLES = "/usr/sbin/iptables-restore";
const IP6TABLES = "/usr/sbin/ip6tables-restore";
const DNSMASQ = "/usr/sbin/dnsmasq";
const SQUID = "/usr/sbin/squid";
const TCPDUMP = "/usr/bin/tcpdump";

function containerPath(environment: SandboxEnvironment, absolutePath: string) {
  return path.join(
    environment.filesystemRoot,
    absolutePath.replace(/^\/+/, ""),
  );
}

function childFailure(
  child: ManagedNetworkProcess,
  service: string,
): Promise<never> {
  const failure = child.result.then((result) => {
    const status = result.signal
      ? `signal ${result.signal}`
      : `code ${result.exitCode}`;
    const detail = [result.stderr.trimEnd(), result.stdout.trimEnd()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${service} exited with ${status} before becoming ready${detail ? `: ${detail}` : ""}`,
    );
  });
  void failure?.catch(() => undefined);
  return failure;
}

function managedProcessFailure(
  name: string,
  outcome: ProcessResult | unknown,
): Error {
  if (outcome instanceof Error) {
    return new Error(`${name} failed: ${outcome.message}`, { cause: outcome });
  }
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    !("exitCode" in outcome)
  ) {
    return new Error(`${name} failed with an unexpected process result.`, {
      cause: outcome,
    });
  }
  const result = outcome as ProcessResult;
  const status = result.signal
    ? `signal ${result.signal}`
    : `code ${result.exitCode}`;
  return new Error(`${name} exited with ${status}`);
}

const INITIAL_PORT_POLL_INTERVAL_MILLISECONDS = 5;
const MAX_PORT_POLL_INTERVAL_MILLISECONDS = 50;
const PORT_CONNECTION_TIMEOUT_MILLISECONDS = 250;

async function waitForPort(
  tcp: TcpService,
  clock: Clock,
  signal: AbortSignal | undefined,
  throwIfCancelled: () => void,
  options: {
    readonly service: string;
    readonly host: string;
    readonly port: number;
    readonly startupTimeoutMilliseconds: number;
    readonly child: ManagedNetworkProcess;
  },
): Promise<void> {
  const failure = childFailure(options.child, options.service);
  const deadline = clock.now() + options.startupTimeoutMilliseconds;
  let pollInterval = INITIAL_PORT_POLL_INTERVAL_MILLISECONDS;
  while (clock.now() < deadline) {
    throwIfCancelled();
    const remainingMilliseconds = deadline - clock.now();
    const connected = await tcp.canConnect(
      { host: options.host, port: options.port },
      {
        timeoutMilliseconds: Math.min(
          PORT_CONNECTION_TIMEOUT_MILLISECONDS,
          remainingMilliseconds,
        ),
        ...(signal ? { signal } : {}),
      },
    );
    if (connected) return;
    throwIfCancelled();
    const delayMilliseconds = Math.min(pollInterval, deadline - clock.now());
    if (delayMilliseconds <= 0) break;
    const delay = clock.sleep(
      delayMilliseconds,
      signal ? { signal } : undefined,
    );
    await Promise.race([failure, delay]);
    pollInterval = Math.min(
      pollInterval * 2,
      MAX_PORT_POLL_INTERVAL_MILLISECONDS,
    );
  }
  throw new Error(
    `${options.service} failed to start on ${options.host}:${options.port}`,
  );
}

function readUpstreamResolver(environment: SandboxEnvironment): string {
  const resolverPath = containerPath(environment, "/etc/resolv.conf");
  const resolver = fs.readFileSync(resolverPath, "utf8");
  fs.copyFileSync(
    resolverPath,
    containerPath(environment, "/etc/resolv.conf.upstream"),
  );
  const upstream = resolver
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^nameserver\s+(\S+)/)?.[1])
    .find((value): value is string => Boolean(value));
  if (!upstream) throw new Error("No upstream DNS server found");
  return upstream;
}

function isLinkLocalInterfaceReady(
  environment: SandboxEnvironment,
  interfaceName: string,
): boolean {
  const interfacesPath = containerPath(environment, "/proc/net/if_inet6");
  const interfaces = fs.existsSync(interfacesPath)
    ? fs.readFileSync(interfacesPath, "utf8")
    : "";
  return interfaces.split(/\r?\n/u).some((line) => {
    const fields = line.trim().split(/\s+/u);
    const flags = Number.parseInt(fields[4] ?? "", 16);
    return (
      fields[3] === "20" &&
      fields[5] === interfaceName &&
      Number.isFinite(flags) &&
      (flags & 0x40) === 0
    );
  });
}

async function waitForScopedIpv6Resolver(options: {
  readonly environment: SandboxEnvironment;
  readonly tcp: TcpService;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
  readonly throwIfCancelled: () => void;
  readonly upstream: string;
}): Promise<void> {
  const [address, interfaceName] = options.upstream.split("%", 2);
  if (!address || !interfaceName) {
    throw new Error(`Invalid scoped IPv6 DNS resolver: ${options.upstream}`);
  }
  const interfaceDeadline = options.clock.now() + 5_000;
  while (options.clock.now() < interfaceDeadline) {
    options.throwIfCancelled();
    if (isLinkLocalInterfaceReady(options.environment, interfaceName)) break;
    await options.clock.sleep(
      100,
      options.signal ? { signal: options.signal } : undefined,
    );
  }
  if (!isLinkLocalInterfaceReady(options.environment, interfaceName)) {
    throw new Error(
      `The Apple container IPv6 interface ${interfaceName} was not ready within 5 seconds.`,
    );
  }
  const resolverDeadline = options.clock.now() + 5_000;
  while (options.clock.now() < resolverDeadline) {
    options.throwIfCancelled();
    const connected = await options.tcp.canConnect(
      { host: options.upstream, port: 53 },
      {
        timeoutMilliseconds: 250,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (connected) return;
    await options.clock.sleep(
      100,
      options.signal ? { signal: options.signal } : undefined,
    );
  }
  throw new Error(
    `The Apple host IPv6 DNS resolver on ${interfaceName} did not respond within 5 seconds.`,
  );
}

async function prepareSquidFilesystem(
  environment: SandboxEnvironment,
  throwIfCancelled: () => void,
  debug: (message: string) => void,
  writeFile: (filePath: string, content: string) => void,
  ensureDirectory: (directoryPath: string) => void,
  touchFiles: (paths: readonly string[]) => void,
  setOwnership: (
    paths: readonly string[],
    owner: string,
    recursive: boolean,
  ) => Promise<void>,
  options: {
    readonly config: string;
    readonly domainAclGroups?: readonly SquidDomainAclGroup[];
    readonly blockedErrorPage?: string;
  },
): Promise<void> {
  touchFiles(["/var/log/proxy-access.log", "/var/log/squid-cache.log"]);
  ensureDirectory("/var/log/squid");
  ensureDirectory("/var/spool/squid");
  await setOwnership(
    ["/var/log/proxy-access.log", "/var/log/squid-cache.log"],
    "proxy:proxy",
    false,
  );
  await setOwnership(
    ["/var/log/squid", "/var/spool/squid"],
    "proxy:proxy",
    true,
  );
  throwIfCancelled();
  fs.chmodSync(containerPath(environment, "/var/log/squid-cache.log"), 0o644);
  ensureDirectory("/etc/squid");
  writeFile("/etc/squid/squid.conf", options.config);
  const domainAclGroups = options.domainAclGroups ?? [];
  for (const group of domainAclGroups) {
    writeFile(getSquidDomainAclPath(group.id), group.content);
  }
  debug(`prepared ${domainAclGroups.length} Squid domain ACL groups`);
  if (options.blockedErrorPage === undefined) return;
  ensureDirectory("/usr/share/squid/errors/custom");
  try {
    fs.cpSync(
      containerPath(environment, "/usr/share/squid/errors/en"),
      containerPath(environment, "/usr/share/squid/errors/custom"),
      { recursive: true, force: true },
    );
  } catch (error) {
    debug(`default Squid error pages unavailable: ${getErrorMessage(error)}`);
  }
  writeFile(
    "/usr/share/squid/errors/custom/ERR_SANDBOX_BLOCKED",
    options.blockedErrorPage,
  );
}

function createNetworkInterface(
  environment: SandboxEnvironment,
  processes: ProcessManager,
  tcp: TcpService,
  clock: Clock,
  signal: AbortSignal | undefined,
  throwIfCancelled: () => void,
  debug: (message: string) => void,
  writeFile: (filePath: string, content: string) => void,
  ensureDirectory: (directoryPath: string) => void,
  touchFiles: (paths: readonly string[]) => void,
  setOwnership: (
    paths: readonly string[],
    owner: string,
    recursive: boolean,
  ) => Promise<void>,
  spawnNetworkCommand: (options: {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly stdoutFile?: string;
    readonly fatal?: boolean;
  }) => ManagedNetworkProcess,
  failure: Promise<Error>,
): ContainerNetworkSystem {
  return {
    failure,
    async applyFirewall(commands) {
      debug(
        `${chalk.cyan("iptables-restore")}: installing ${commands.length} commands`,
      );
      await restoreFirewall({
        processes,
        command: IPTABLES,
        commands,
        ...(signal ? { signal } : {}),
      });
      debug("IPv4 firewall configured");
    },
    async applyIpv6Firewall(commands) {
      debug(
        `${chalk.cyan("ip6tables-restore")}: installing ${commands.length} commands`,
      );
      await restoreFirewall({
        processes,
        command: IP6TABLES,
        commands,
        ...(signal ? { signal } : {}),
      });
      debug("IPv6 firewall configured");
    },
    async applyHostMappings(mappings) {
      if (mappings.length === 0) return;
      const hostsPath = containerPath(environment, "/etc/hosts");
      const current = fs.readFileSync(hostsPath, "utf8");
      const mappedHosts = new Set(mappings.map(({ host }) => host));
      const retained = current
        .split(/\r?\n/u)
        .filter(
          (line) => !line.split(/\s+/u).some((part) => mappedHosts.has(part)),
        );
      const records = mappings.map(
        ({ host, address }) => `${address}\t${host}`,
      );
      fs.writeFileSync(
        hostsPath,
        `${retained.filter(Boolean).join("\n")}\n${records.join("\n")}\n`,
      );
      debug(`applied ${mappings.length} guest host mappings`);
    },
    async discoverUpstreamDns() {
      throwIfCancelled();
      const upstream = readUpstreamResolver(environment);
      if (!upstream.includes(":")) return upstream;
      await waitForScopedIpv6Resolver({
        environment,
        tcp,
        clock,
        ...(signal ? { signal } : {}),
        throwIfCancelled,
        upstream,
      });
      return upstream;
    },
    startDnsmasq({ config }) {
      ensureDirectory("/etc/dnsmasq.d");
      writeFile("/etc/dnsmasq.d/sandbox.conf", config);
      const args = ["--keep-in-foreground", "--conf-dir=/etc/dnsmasq.d"];
      debug("starting managed dnsmasq");
      writeFile("/etc/resolv.conf", "nameserver 127.0.0.1\n");
      const child = spawnNetworkCommand({
        name: "dnsmasq",
        command: DNSMASQ,
        args,
      });
      return waitForPort(tcp, clock, signal, throwIfCancelled, {
        service: "dnsmasq",
        host: "127.0.0.1",
        port: 53,
        startupTimeoutMilliseconds: 5_000,
        child,
      }).then(() => {
        debug("dnsmasq started");
      });
    },
    async startSquid({ config, domainAclGroups, blockedErrorPage }) {
      await prepareSquidFilesystem(
        environment,
        throwIfCancelled,
        debug,
        writeFile,
        ensureDirectory,
        touchFiles,
        setOwnership,
        {
          config,
          ...(domainAclGroups !== undefined ? { domainAclGroups } : {}),
          ...(blockedErrorPage !== undefined ? { blockedErrorPage } : {}),
        },
      );
      const args = ["-N", "-f", "/etc/squid/squid.conf"];
      debug("starting managed squid");
      const child = spawnNetworkCommand({
        name: "squid",
        command: SQUID,
        args,
      });
      await waitForPort(tcp, clock, signal, throwIfCancelled, {
        service: "squid",
        host: "127.0.0.1",
        port: 8888,
        startupTimeoutMilliseconds: 10_000,
        child,
      });
      debug("squid started");
    },
    async startNetworkTrace() {
      touchFiles(["/var/log/firewall-blocked.log"]);
      spawnNetworkCommand({
        name: "tcpdump",
        command: TCPDUMP,
        args: ["-i", "nflog:100", "-l", "-n", "-tt"],
        stdoutFile: "/var/log/firewall-blocked.log",
        fatal: false,
      });
    },
  };
}

function createNetworkSystem(
  environment: SandboxEnvironment,
  processes: ProcessManager,
  tcp: TcpService,
  clock: Clock,
  signal: AbortSignal | undefined,
): ContainerNetworkSystem {
  let resolveFailure: (error: Error) => void = () => undefined;
  const failure = new Promise<Error>((resolve) => {
    resolveFailure = resolve;
  });

  function throwIfCancelled(): void {
    signal?.throwIfAborted();
  }

  function debug(message: string): void {
    getLogger().debug(`network: ${message}`);
  }

  async function runCommand(
    command: string,
    args: readonly string[],
  ): Promise<string> {
    throwIfCancelled();
    return await executeContainerCommand(
      command,
      args,
      signal ? { signal } : {},
    );
  }

  function writeFile(filePath: string, content: string): void {
    throwIfCancelled();
    const resolved = containerPath(environment, filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);
  }

  function ensureDirectory(directoryPath: string): void {
    throwIfCancelled();
    fs.mkdirSync(containerPath(environment, directoryPath), {
      recursive: true,
    });
  }

  function touchFiles(paths: readonly string[]): void {
    for (const filePath of paths) {
      throwIfCancelled();
      const resolved = containerPath(environment, filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.closeSync(fs.openSync(resolved, "a"));
    }
  }

  async function setOwnership(
    paths: readonly string[],
    owner: string,
    recursive: boolean,
  ): Promise<void> {
    await runCommand("/usr/bin/chown", [
      ...(recursive ? ["-R"] : []),
      owner,
      ...paths,
    ]);
  }

  function spawnNetworkCommand(options: {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly stdoutFile?: string;
    readonly fatal?: boolean;
  }): ManagedNetworkProcess {
    throwIfCancelled();
    const child = processes.start({
      command: options.command,
      args: options.args,
      name: options.name,
      lifetime: "application",
      interaction: { mode: "non-interactive" },
      ...(options.stdoutFile
        ? {
            stdoutFile: {
              path: containerPath(environment, options.stdoutFile),
              append: true,
            },
          }
        : {}),
    });
    void child.result.then(
      (result) => {
        const error = managedProcessFailure(options.name, result);
        if (options.fatal ?? true) resolveFailure(error);
        else if (!result.signal) getLogger().warn(error.message);
      },
      (error: unknown) => {
        const failureError = managedProcessFailure(options.name, error);
        if (options.fatal ?? true) resolveFailure(failureError);
        else getLogger().warn(failureError.message);
      },
    );
    return child;
  }

  return createNetworkInterface(
    environment,
    processes,
    tcp,
    clock,
    signal,
    throwIfCancelled,
    debug,
    writeFile,
    ensureDirectory,
    touchFiles,
    setOwnership,
    spawnNetworkCommand,
    failure,
  );
}

export function createContainerNetworkSystem(
  options: { readonly signal?: AbortSignal } = {},
): ContainerNetworkSystem {
  return createNetworkSystem(
    getSandboxEnvironment(),
    getProcessManager(),
    getTcpService(),
    getClock(),
    options.signal,
  );
}
