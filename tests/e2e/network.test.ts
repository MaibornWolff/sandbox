import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("network");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `allow_network = [
  "registry.npmjs.org",
]
`,
  );
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    "FROM sandbox-base:latest\nENV SANDBOX_IDLE_TIMEOUT_SECONDS=30\n",
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 60 });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("network enforcement", () => {
  test("allowed domain reachable", async () => {
    const { exitCode } = await sb.run(
      "curl",
      "-fsS",
      "--retry",
      "3",
      "--retry-all-errors",
      "--retry-delay",
      "1",
      "--connect-timeout",
      "10",
      "--max-time",
      "45",
      "https://registry.npmjs.org/-/ping",
    );
    expect(exitCode).toBe(0);
  }, 60_000);

  test("blocked domain in default mode", async () => {
    const { exitCode } = await sb.run(
      "curl",
      "-fsS",
      "-m",
      "10",
      "https://example.com",
    );
    expect(exitCode).not.toBe(0);
  }, 60_000);

  test("allowed domain in full-network mode", async () => {
    const { exitCode } = await sb.runFullNetwork(
      "curl",
      "-fsS",
      "-m",
      "10",
      "https://example.com",
    );
    expect(exitCode).toBe(0);
  }, 60_000);
});

describe("DNS firewall", () => {
  test("runs dnsmasq processes as their dedicated user", async () => {
    const { stdout, exitCode } = await sb.run(
      "ps",
      "-o",
      "pid=,ppid=,stat=,user=,args=",
      "-C",
      "dnsmasq",
    );
    expect(exitCode).toBe(0);
    const processes = stdout.trim().split("\n");
    const expectedDnsmasqProcess = /^\s*\d+\s+\d+\s+\S+\s+dnsmasq\s+/;
    if (
      processes.length === 0 ||
      !processes.every((process) => expectedDnsmasqProcess.test(process))
    ) {
      throw new Error(
        `Expected at least one dnsmasq process and every process owned by dnsmasq. Complete ps stdout:\n${stdout}`,
      );
    }
  });

  test("allowed domain resolves via DNS", async () => {
    const { stdout, exitCode } = await sb.run("nslookup", "registry.npmjs.org");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Address:");
    // Should NOT contain NXDOMAIN or SERVFAIL
    expect(stdout).not.toContain("NXDOMAIN");
    expect(stdout).not.toContain("SERVFAIL");
  }, 30_000);

  test("blocked domain returns NXDOMAIN via DNS", async () => {
    const { exitCode } = await sb.run("nslookup", "google.de");
    // nslookup returns non-zero on NXDOMAIN
    expect(exitCode).not.toBe(0);
  }, 30_000);

  test("allowed domain resolves in full-network mode", async () => {
    const { stdout, exitCode } = await sb.runFullNetwork(
      "nslookup",
      "google.de",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Address:");
  }, 30_000);
});

describe("network diagnostics", () => {
  test("provides route, address, and socket diagnostics", async () => {
    const routes = await sb.run("ip", "route");
    const addresses = await sb.run("ip", "-brief", "address");
    const sockets = await sb.run("ss", "-lntup");

    expect(routes.exitCode).toBe(0);
    const routeInterface = routes.stdout.match(/^default .*\bdev (\S+)/mu)?.[1];
    expect(routeInterface, routes.stdout).toBeDefined();
    expect(routeInterface).not.toBe("lo");
    expect(addresses.exitCode).toBe(0);
    expect(addresses.stdout).toContain("lo");
    expect(addresses.stdout).toContain(
      routeInterface ?? "missing default route",
    );
    expect(sockets.exitCode).toBe(0);
    expect(sockets.stdout).toContain("127.0.0.1:8888");
  }, 60_000);

  test("reports a blocked request observed by the real network stack", async () => {
    await sb.run("curl", "-fsS", "-m", "5", "https://example.com");

    const { stdout, exitCode } = await sb.networkLogs();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("example.com");
    expect(stdout).toContain("BLOCKED");
  }, 60_000);
});
