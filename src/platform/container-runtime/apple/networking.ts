import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import { BlockList, isIP } from "node:net";
import * as path from "node:path";
import chalk from "chalk";
import { type Clock, getClock } from "#platform/clock/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  createFile,
  ensureDirectory,
  readTextFile,
  removePath,
  tryCreateHardLink,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  getCurrentPid,
  getProcessIdentityStatus,
} from "#platform/process/index.js";
import type { RuntimeExecutor } from "../executor.js";
import type { AppleContainerOptions } from "../runtime-options.js";
import { APPLE_HOST_ACCESS_NAMES } from "./host-metadata.js";

const NETWORK_NAME = "default";
const HELPER_IMAGE = "docker.io/library/alpine:3.22";
const LOCK_WAIT_MILLISECONDS = 15_000;
const LOCK_RETRY_MILLISECONDS = 100;
const NETWORK_ACTIVATION_WAIT_MILLISECONDS = 15_000;

interface AppleNetworkJson {
  readonly configuration?: {
    readonly creationDate?: string;
    readonly name?: string;
  };
  readonly id?: string;
  readonly status?: {
    readonly ipv4Gateway?: string;
    readonly ipv4Subnet?: string;
    readonly ipv6Subnet?: string;
  };
}

interface AppleBuilderJson {
  readonly configuration?: {
    readonly dns?: { readonly nameservers?: readonly string[] };
    readonly networks?: readonly { readonly network?: string }[];
  };
  readonly id?: string;
  readonly status?: { readonly state?: string };
}

interface AppleContainerJson {
  readonly id?: string;
  readonly configuration?: { readonly id?: string };
  readonly status?: { readonly state?: string };
}

interface NetworkIdentity {
  readonly key: string;
  readonly gateway: string;
  readonly subnet: string;
}

interface HelperLease extends AsyncDisposable {
  readonly id: string;
}

interface NetworkLease extends AsyncDisposable {
  readonly helper?: HelperLease;
  readonly network: NetworkIdentity;
}

interface NetworkSnapshot extends AsyncDisposable {
  readonly established: NetworkLease;
  readonly resolverIdentity?: string;
}

interface StartupScope {
  readonly resources: AsyncDisposableStack;
  snapshot?: Promise<NetworkSnapshot>;
}

interface ResolverLease extends AsyncDisposable {
  readonly resolver: string;
}

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

interface LockTiming {
  readonly retryMilliseconds: number;
  readonly waitMilliseconds: number;
}

export interface AppleRunNetworkPlan extends AsyncDisposable {
  readonly dns?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly networkName: string;
}

export interface AppleNetworkOperations {
  prepareBuild(): Promise<void>;
  prepareRun(): Promise<AppleRunNetworkPlan>;
}

function parseArray(output: string, resource: string): readonly unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error(`Apple container returned invalid ${resource} JSON.`, {
      cause: error,
    });
  }
  if (!Array.isArray(value)) {
    throw new Error(`Apple container returned invalid ${resource} data.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findNetwork(
  output: string,
  networkName: string,
): AppleNetworkJson | null {
  const values = parseArray(output, "network list");
  const network = values.find((value) => {
    if (!isRecord(value)) return false;
    const candidate = value as AppleNetworkJson;
    return (
      candidate.id === networkName ||
      candidate.configuration?.name === networkName
    );
  });
  return (network as AppleNetworkJson | undefined) ?? null;
}

function networkIdentity(
  network: AppleNetworkJson,
  networkName: string,
): NetworkIdentity | null {
  const gateway = network.status?.ipv4Gateway;
  const subnet = network.status?.ipv4Subnet;
  const ipv6Subnet = network.status?.ipv6Subnet;
  if (!gateway || !subnet || !ipv6Subnet) return null;
  return {
    gateway,
    subnet,
    key: JSON.stringify({
      id: network.id ?? networkName,
      creationDate: network.configuration?.creationDate ?? "",
      gateway,
      subnet,
      ipv6Subnet,
    }),
  };
}

function parseBuilder(output: string): AppleBuilderJson | null {
  const values = parseArray(output, "builder status");
  const value = values.find((entry) => isRecord(entry)) as
    | AppleBuilderJson
    | undefined;
  return value ?? null;
}

function parseRunningContainerIds(output: string): readonly string[] {
  return parseArray(output, "container list").flatMap((value) => {
    if (!isRecord(value)) return [];
    const container = value as AppleContainerJson;
    if (container.status?.state !== "running") return [];
    const id = container.configuration?.id ?? container.id;
    return id ? [id] : [];
  });
}

const guestUnusableDnsAddresses = new BlockList();
guestUnusableDnsAddresses.addSubnet("0.0.0.0", 8, "ipv4");
guestUnusableDnsAddresses.addSubnet("127.0.0.0", 8, "ipv4");
guestUnusableDnsAddresses.addSubnet("169.254.0.0", 16, "ipv4");
guestUnusableDnsAddresses.addSubnet("224.0.0.0", 4, "ipv4");
guestUnusableDnsAddresses.addAddress("::", "ipv6");
guestUnusableDnsAddresses.addAddress("::1", "ipv6");
guestUnusableDnsAddresses.addSubnet("fe80::", 10, "ipv6");
guestUnusableDnsAddresses.addSubnet("ff00::", 8, "ipv6");

function isGuestUsableHostResolver(address: string): boolean {
  const version = isIP(address);
  if (version === 0 || address.includes("%")) return false;
  return !guestUnusableDnsAddresses.check(
    address,
    version === 4 ? "ipv4" : "ipv6",
  );
}

function isGlobalHostResolver(resolver: string): boolean {
  return (
    !/^\s*domain\s*:/mu.test(resolver) &&
    !/^\s*flags\s*:.*\bScoped\b/mu.test(resolver)
  );
}

function parseHostResolver(output: string): string {
  const primary =
    output
      .split("DNS configuration (for scoped queries)")[0]
      ?.split(/^resolver #\d+\s*$/mu)[1] ?? "";
  for (const match of primary.matchAll(
    /^\s*nameserver\[\d+\]\s*:\s*(\S+)/gmu,
  )) {
    const address = match[1];
    if (
      address &&
      isGlobalHostResolver(primary) &&
      isGuestUsableHostResolver(address)
    )
      return address;
  }
  throw new Error(
    "macOS has no guest-reachable primary DNS server. Host DNS mode cannot use loopback or link-local resolvers. Configure a remote DNS server on macOS or select another Apple DNS mode.",
  );
}

function parseBridgeResolver(output: string, gateway: string): string | null {
  const blocks = output.split(/(?=^[A-Za-z0-9][^\s:]*: flags=)/mu);
  for (const block of blocks) {
    if (
      !new RegExp(
        `^\\s*inet\\s+${gateway.replaceAll(".", "\\.")}\\s`,
        "mu",
      ).test(block)
    ) {
      continue;
    }
    const linkLocal = block.match(/^\s*inet6\s+(fe80::[^%\s]+)%[^\s]+/imu)?.[1];
    if (linkLocal) return linkLocal;
  }
  return null;
}

function parseGuestInterface(output: string, subnet: string): string | null {
  const route = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith(`${subnet} `));
  const interfaceName = route?.match(/\bdev\s+(\S+)/u)?.[1];
  if (!interfaceName) return null;
  const hasAddress = output
    .split(/\r?\n/u)
    .some((line) =>
      new RegExp(`^\\d+:\\s+${interfaceName}\\s+inet\\s+`, "u").test(line),
    );
  return hasAddress ? interfaceName : null;
}

function mappingsEnvironment(
  gateway: string,
): Readonly<Record<string, string>> {
  return {
    SANDBOX_GUEST_HOST_MAPPINGS: JSON.stringify(
      APPLE_HOST_ACCESS_NAMES.map((host) => ({ host, address: gateway })),
    ),
  };
}

function parseLockOwner(lockPath: string): LockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(readTextFile(lockPath));
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.token !== "string" ||
    value.token.length === 0
  ) {
    return null;
  }
  return { pid: value.pid as number, token: value.token };
}

function removeIfOwned(lockPath: string, token: string): void {
  if (parseLockOwner(lockPath)?.token === token) removePath(lockPath);
}

/** @testonly */
export async function acquireAppleBuilderLock(
  lockPath: string,
  clock: Clock,
  timing: LockTiming = {
    retryMilliseconds: LOCK_RETRY_MILLISECONDS,
    waitMilliseconds: LOCK_WAIT_MILLISECONDS,
  },
): Promise<AsyncDisposable> {
  ensureDirectory(path.dirname(lockPath));
  const owner: LockOwner = {
    pid: getCurrentPid(),
    token: crypto.randomUUID(),
  };
  const candidatePath = `${lockPath}.owner-${owner.token}`;
  const candidate = createFile(candidatePath, JSON.stringify(owner));
  if (!candidate.created) {
    throw new Error("Failed to create an Apple builder DNS lock owner record.");
  }
  using resources = new DisposableStack();
  resources.defer(() => removePath(candidatePath));
  const deadline = clock.now() + timing.waitMilliseconds;
  while (true) {
    if (tryCreateHardLink(candidatePath, lockPath)) {
      resources.defer(() => removeIfOwned(lockPath, owner.token));
      getLogger().debug(
        `Acquired Apple builder DNS lock ${chalk.dim(lockPath)}`,
      );
      const lease = resources.move();
      return {
        async [Symbol.asyncDispose]() {
          lease.dispose();
          getLogger().debug(
            `Released Apple builder DNS lock ${chalk.dim(lockPath)}`,
          );
        },
      };
    }
    const currentOwner = parseLockOwner(lockPath);
    if (
      currentOwner &&
      getProcessIdentityStatus(currentOwner.pid) === "missing"
    ) {
      // Node has no atomic compare-and-delete. Recovery could remove a new owner's lock.
      throw new Error(
        `Apple builder DNS lock ${chalk.dim(lockPath)} belongs to stopped process ${currentOwner.pid}. Remove the lock file only when no Sandbox builds are running, then retry.`,
      );
    }
    if (clock.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the shared Apple builder DNS lock at ${chalk.dim(lockPath)}.`,
      );
    }
    await clock.sleep(timing.retryMilliseconds);
  }
}

export class AppleNetworking implements AppleNetworkOperations {
  private builderPreparation: Promise<void> | undefined;
  private readonly startupScope = new AsyncLocalStorage<StartupScope>();

  constructor(
    private readonly exec: RuntimeExecutor,
    private readonly options: AppleContainerOptions,
    private readonly selectedNetwork = NETWORK_NAME,
  ) {}

  async withInstanceStartup<T>(operation: () => Promise<T>): Promise<T> {
    await using resources = new AsyncDisposableStack();
    return await this.startupScope.run({ resources }, operation);
  }

  private async snapshot(
    resources: AsyncDisposableStack,
  ): Promise<NetworkSnapshot> {
    const scope = this.startupScope.getStore();
    if (!scope) return resources.use(await this.discoverSnapshot());
    scope.snapshot ??= this.discoverSnapshot().then((snapshot) =>
      scope.resources.use(snapshot),
    );
    return await scope.snapshot;
  }

  private async discoverSnapshot(): Promise<NetworkSnapshot> {
    await using resources = new AsyncDisposableStack();
    const [networkResult, hostResult] = await Promise.allSettled([
      this.establishNetwork(),
      this.options.dns === "host"
        ? this.readHostResolver()
        : Promise.resolve(undefined),
    ]);
    if (networkResult.status === "rejected") throw networkResult.reason;
    let established = resources.use(networkResult.value);
    if (hostResult.status === "rejected") throw hostResult.reason;
    let resolverIdentity = hostResult.value;
    if (this.options.dns === "host-ipv6") {
      resolverIdentity =
        (await this.readBridgeResolver(established.network)) ?? undefined;
      if (!resolverIdentity) {
        if (!established.helper) {
          const helper = resources.use(await this.createHelperContainer());
          established = { ...established, helper };
        }
        resolverIdentity = await this.waitForBridgeResolver(
          established.network,
        );
      }
    }
    const lease = resources.move();
    return {
      established,
      resolverIdentity,
      [Symbol.asyncDispose]: () => lease.disposeAsync(),
    };
  }

  private async readNetwork(): Promise<AppleNetworkJson | null> {
    return findNetwork(
      await this.exec("container", ["network", "list", "--format", "json"]),
      this.selectedNetwork,
    );
  }

  private async createHelperContainer(): Promise<HelperLease> {
    const id = `sandbox-network-${crypto.randomUUID()}`;
    const exec = this.exec;
    await exec("container", [
      "run",
      "-d",
      "--name",
      id,
      "--network",
      this.selectedNetwork,
      HELPER_IMAGE,
      "sleep",
      "300",
    ]);
    let disposed = false;
    return {
      id,
      async [Symbol.asyncDispose]() {
        if (disposed) return;
        disposed = true;
        await exec("container", ["delete", "-f", id]);
      },
    };
  }

  private async establishNetwork(): Promise<NetworkLease> {
    let selected = await this.readNetwork();
    if (!selected) {
      await this.exec("container", ["network", "create", this.selectedNetwork]);
      selected = await this.readNetwork();
    }
    const active = selected
      ? networkIdentity(selected, this.selectedNetwork)
      : null;
    if (active) {
      return {
        network: active,
        async [Symbol.asyncDispose]() {},
      };
    }

    const helper = await this.createHelperContainer();
    try {
      let deadline: number | undefined;
      while (true) {
        const activated = await this.readNetwork();
        const identity = activated
          ? networkIdentity(activated, this.selectedNetwork)
          : null;
        if (identity) {
          return {
            helper,
            network: identity,
            [Symbol.asyncDispose]: () => helper[Symbol.asyncDispose](),
          };
        }
        const clock = getClock();
        deadline ??= clock.now() + NETWORK_ACTIVATION_WAIT_MILLISECONDS;
        if (clock.now() >= deadline) {
          throw new Error(
            `Apple container network ${this.selectedNetwork} did not become active with complete IPv4 and IPv6 status.`,
          );
        }
        await clock.sleep(LOCK_RETRY_MILLISECONDS);
      }
    } catch (error) {
      await helper[Symbol.asyncDispose]();
      throw error;
    }
  }

  async compatibilityIdentity(): Promise<string> {
    await using resources = new AsyncDisposableStack();
    const { established, resolverIdentity } = await this.snapshot(resources);
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          dns: this.options.dns,
          network: established.network.key,
          resolverIdentity,
        }),
      )
      .digest("hex")
      .slice(0, 16);
  }

  private async readBridgeResolver(
    network: NetworkIdentity,
  ): Promise<string | null> {
    return parseBridgeResolver(
      await this.exec("ifconfig", ["-a"]),
      network.gateway,
    );
  }

  private async waitForBridgeResolver(
    network: NetworkIdentity,
  ): Promise<string> {
    let deadline: number | undefined;
    while (true) {
      const resolver = await this.readBridgeResolver(network);
      if (resolver) return resolver;
      const clock = getClock();
      deadline ??= clock.now() + NETWORK_ACTIVATION_WAIT_MILLISECONDS;
      if (clock.now() >= deadline) {
        throw new Error(
          `Apple container network ${this.selectedNetwork} has no host bridge for gateway ${network.gateway}.`,
        );
      }
      await clock.sleep(LOCK_RETRY_MILLISECONDS);
    }
  }

  private async guestResolver(
    id: string,
    network: NetworkIdentity,
    bridgeResolver: string,
  ): Promise<string | null> {
    const guestNetwork = await this.exec("container", [
      "exec",
      id,
      "sh",
      "-c",
      "ip -o -4 addr show; ip -o -4 route show",
    ]);
    const guestInterface = parseGuestInterface(guestNetwork, network.subnet);
    return guestInterface ? `${bridgeResolver}%${guestInterface}` : null;
  }

  private async resolverFromHelper(
    helper: HelperLease,
    network: NetworkIdentity,
    bridgeResolver: string,
  ): Promise<ResolverLease> {
    try {
      const resolver = await this.guestResolver(
        helper.id,
        network,
        bridgeResolver,
      );
      if (!resolver) {
        throw new Error(
          `Apple container network ${this.selectedNetwork} has no matching guest interface for ${network.subnet}.`,
        );
      }
      return {
        resolver,
        [Symbol.asyncDispose]: () => helper[Symbol.asyncDispose](),
      };
    } catch (error) {
      await helper[Symbol.asyncDispose]();
      throw error;
    }
  }

  private async discoverActiveResolver(
    network: NetworkIdentity,
    bridgeResolver: string,
  ): Promise<string | null> {
    const builder = parseBuilder(
      await this.exec("container", ["builder", "status", "--format", "json"]),
    );
    const builderResolver = builder?.configuration?.dns?.nameservers?.[0];
    const builderUsesNetwork = builder?.configuration?.networks?.some(
      ({ network: name }) => name === this.selectedNetwork,
    );
    if (
      builder?.status?.state === "running" &&
      builderUsesNetwork &&
      builderResolver?.startsWith(`${bridgeResolver}%`)
    ) {
      return builderResolver;
    }
    const ids = parseRunningContainerIds(
      await this.exec("container", ["list", "--format", "json"]),
    );
    for (const id of ids) {
      const resolver = await this.guestResolver(id, network, bridgeResolver);
      if (resolver) return resolver;
    }
    return null;
  }

  private async discoverResolver(
    network: NetworkIdentity,
    bridgeResolver?: string,
  ): Promise<ResolverLease> {
    const existingBridge =
      bridgeResolver ?? (await this.readBridgeResolver(network));
    if (!existingBridge) {
      const helper = await this.createHelperContainer();
      try {
        return await this.resolverFromHelper(
          helper,
          network,
          await this.waitForBridgeResolver(network),
        );
      } catch (error) {
        await helper[Symbol.asyncDispose]();
        throw error;
      }
    }
    const activeResolver = await this.discoverActiveResolver(
      network,
      existingBridge,
    );
    if (activeResolver) {
      return {
        resolver: activeResolver,
        async [Symbol.asyncDispose]() {},
      };
    }
    return await this.resolverFromHelper(
      await this.createHelperContainer(),
      network,
      existingBridge,
    );
  }

  private async readHostResolver(): Promise<string> {
    return parseHostResolver(await this.exec("scutil", ["--dns"]));
  }

  private async prepareResolver(
    established: NetworkLease,
    resolverIdentity?: string,
  ): Promise<ResolverLease> {
    if (this.options.dns === "host") {
      return {
        resolver: resolverIdentity ?? (await this.readHostResolver()),
        async [Symbol.asyncDispose]() {},
      };
    }
    return established.helper
      ? await this.resolverFromHelper(
          established.helper,
          established.network,
          resolverIdentity ??
            (await this.waitForBridgeResolver(established.network)),
        )
      : await this.discoverResolver(established.network, resolverIdentity);
  }

  async prepareRun(): Promise<AppleRunNetworkPlan> {
    await using resources = new AsyncDisposableStack();
    const snapshot = await this.snapshot(resources);
    const { established, resolverIdentity } = snapshot;
    const resolver =
      this.options.dns === "default"
        ? undefined
        : resources.use(
            await this.prepareResolver(established, resolverIdentity),
          );
    const lease = resources.move();
    const plan: AppleRunNetworkPlan = {
      dns: resolver?.resolver,
      environment: mappingsEnvironment(established.network.gateway),
      networkName: this.selectedNetwork,
      [Symbol.asyncDispose]: () => lease.disposeAsync(),
    };
    const scope = this.startupScope.getStore();
    if (!scope) return plan;
    scope.resources.use(plan);
    return { ...plan, async [Symbol.asyncDispose]() {} };
  }

  async prepareBuild(): Promise<void> {
    if (this.options.dns === "default") return;
    this.builderPreparation ??= this.prepareBuilderDns().then(
      () => {
        this.builderPreparation = undefined;
      },
      (error: unknown) => {
        this.builderPreparation = undefined;
        throw error;
      },
    );
    await this.builderPreparation;
  }

  private async prepareBuilderDns(): Promise<void> {
    getLogger().debug("Checking Apple builder network and DNS settings");
    await using established = await this.establishNetwork();
    const lockPath = path.join(
      getHostEnvironment().dataHomeDirectory,
      "sandbox",
      "locks",
      "apple-builder-dns.lock",
    );
    await using _lock = await acquireAppleBuilderLock(lockPath, getClock());
    await using resolver = await this.prepareResolver(established);
    const before = parseBuilder(
      await this.exec("container", ["builder", "status", "--format", "json"]),
    );
    const nameservers = before?.configuration?.dns?.nameservers ?? [];
    const matches =
      nameservers.length === 1 && nameservers[0] === resolver.resolver;
    if (before?.status?.state === "running" && !matches) {
      throw new Error(
        "Apple builder is active with different DNS settings. Stop active builds before Sandbox changes the shared builder resolver.",
      );
    }
    if (!matches || before?.status?.state !== "running") {
      await this.exec("container", [
        "builder",
        "start",
        "--dns",
        resolver.resolver,
      ]);
    }
    const after = parseBuilder(
      await this.exec("container", ["builder", "status", "--format", "json"]),
    );
    const effective = after?.configuration?.dns?.nameservers ?? [];
    if (
      after?.status?.state !== "running" ||
      effective.length !== 1 ||
      effective[0] !== resolver.resolver
    ) {
      throw new Error(
        `Apple builder did not apply the selected ${this.options.dns} resolver.`,
      );
    }
  }
}
