import { describe, expect, test } from "bun:test";
import { redactCommandForDisplay } from "#shared/text/index.js";
import type { ContainerSpec } from "../container-contract.js";
import {
  buildAppleCreateArgs,
  buildAppleExecArgs,
  buildAppleStartArgs,
} from "./arguments.js";

function createSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "sandbox-alpha",
    image: "sandbox-alpha:latest",
    labels: { "sandbox.project": "alpha" },
    environment: { SANDBOX: "1", API_TOKEN: "secret-value" },
    mounts: [
      {
        type: "bind",
        sourcePath: "C:\\project",
        targetPath: "/workspace",
        readOnly: true,
      },
      {
        type: "volume",
        volumeName: "cache",
        targetPath: "/var/cache",
        readOnly: false,
      },
    ],
    ports: [
      {
        hostAddress: "127.0.0.1",
        hostPort: 8080,
        containerPort: 80,
        protocol: "tcp",
      },
      { hostPort: 5353, containerPort: 53, protocol: "udp" },
    ],
    init: true,
    removeOnExit: true,
    resources: { sharedMemorySize: "1G" },
    security: { capabilities: ["NET_ADMIN"], dockerInDocker: false },
    ...overrides,
  };
}

const resolveMountSource = (mount: ContainerSpec["mounts"][number]): string =>
  mount.type === "bind"
    ? mount.sourcePath
    : `/adapter-volumes/${mount.volumeName}`;

describe("Apple container 1.4.1 arguments", () => {
  test("encodes the complete application specification at create", () => {
    const args = buildAppleCreateArgs(createSpec(), {
      allocateTerminal: false,
      resolveMountSource,
    });

    expect(args).toEqual([
      "create",
      "--rm",
      "--init",
      "--name",
      "sandbox-alpha",
      "--label",
      "sandbox.project=alpha",
      "-e",
      "SANDBOX=1",
      "-e",
      "API_TOKEN=secret-value",
      "-v",
      "C:\\project:/workspace:ro",
      "-v",
      "/adapter-volumes/cache:/var/cache:rw",
      "-p",
      "127.0.0.1:8080:80/tcp",
      "-p",
      "5353:53/udp",
      "--cap-add",
      "NET_ADMIN",
      "sandbox-alpha:latest",
    ]);
    expect(args).not.toContain("--virtualization");
  });

  test("adds the selected network, resolver, and generic guest mappings", () => {
    const args = buildAppleCreateArgs(createSpec(), {
      allocateTerminal: false,
      resolveMountSource,
      networkName: "default",
      dns: "fe80::1234%ens4",
      environment: {
        SANDBOX_GUEST_HOST_MAPPINGS:
          '[{"host":"host.container.internal","address":"192.168.64.1"}]',
      },
    });

    expect(
      args.slice(args.indexOf("--network"), args.indexOf("--network") + 4),
    ).toEqual(["--network", "default", "--dns", "fe80::1234%ens4"]);
    expect(args).toContain(
      'SANDBOX_GUEST_HOST_MAPPINGS=[{"host":"host.container.internal","address":"192.168.64.1"}]',
    );
  });

  test("allocates TTY at create and attaches stdin only at start", () => {
    const createArgs = buildAppleCreateArgs(
      createSpec({ resources: { memoryBytes: 3 * 1024 ** 3 } }),
      { allocateTerminal: true, resolveMountSource },
    );

    expect(createArgs.slice(0, 3)).toEqual(["create", "--tty", "--rm"]);
    expect(createArgs).not.toContain("--interactive");
    expect(
      buildAppleStartArgs("sandbox-alpha", {
        attachStdin: true,
        allocateTerminal: true,
      }),
    ).toEqual(["start", "--attach", "--interactive", "sandbox-alpha"]);
    expect(
      buildAppleStartArgs("sandbox-alpha", {
        attachStdin: false,
        allocateTerminal: true,
      }),
    ).toEqual(["start", "--attach", "sandbox-alpha"]);
    expect(buildAppleStartArgs("sandbox-alpha")).toEqual([
      "start",
      "sandbox-alpha",
    ]);
  });

  test("redacts secret environment values from command diagnostics", () => {
    const args = buildAppleCreateArgs(createSpec(), {
      allocateTerminal: false,
      resolveMountSource,
    });

    const display = redactCommandForDisplay("container", args);
    expect(display).toContain("API_TOKEN=<redacted>");
    expect(display).not.toContain("secret-value");
  });

  test("adds only explicit Docker-in-Docker path permissions", () => {
    const args = buildAppleCreateArgs(
      createSpec({
        mounts: [],
        ports: [],
        security: { capabilities: ["ALL"], dockerInDocker: true },
      }),
      { allocateTerminal: false, resolveMountSource },
    );

    expect(args).toContain("--masked-path");
    expect(args).toContain("--read-only-path");
    expect(args).not.toContain("--virtualization");
  });

  test("encodes captured and attached exec without combining stdin and TTY", () => {
    const spec = {
      command: ["sh", "-c", "exit 17"],
      environment: { CHECK: "1" },
      workingDirectory: "/workspace",
      user: "sandbox",
    };
    expect(buildAppleExecArgs("sandbox-alpha", spec)).toEqual([
      "exec",
      "-u",
      "sandbox",
      "-w",
      "/workspace",
      "-e",
      "CHECK=1",
      "sandbox-alpha",
      "sh",
      "-c",
      "exit 17",
    ]);
    expect(
      buildAppleExecArgs("sandbox-alpha", spec, {
        attachStdin: false,
        allocateTerminal: true,
      }),
    ).toEqual([
      "exec",
      "-t",
      "-u",
      "sandbox",
      "-w",
      "/workspace",
      "-e",
      "CHECK=1",
      "sandbox-alpha",
      "sh",
      "-c",
      "exit 17",
    ]);
  });
});
