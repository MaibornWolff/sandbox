import { describe, expect, test } from "bun:test";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { buildExecArgs } from "./session-arguments.js";

type ExecOptions = Parameters<typeof buildExecArgs>[0];

function execArgs(
  options: Partial<ExecOptions> = {},
  variables: Readonly<Record<string, string>> = {},
): string[] {
  return runWithTestLogger(
    () =>
      buildExecArgs({
        containerName: "sandbox-test-a1b2",
        currentDir: "/test/project",
        command: ["zsh"],
        stdin: true,
        tty: true,
        environment: [],
        proxyEnabled: false,
        ...options,
      }),
    { variables },
  );
}

function environment(args: string[]): Record<string, string> {
  const entries: [string, string][] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-e") continue;
    const assignment = args[index + 1] ?? "";
    const separator = assignment.indexOf("=");
    entries.push([
      assignment.slice(0, separator),
      assignment.slice(separator + 1),
    ]);
  }
  expect(new Set(entries.map(([name]) => name)).size).toBe(entries.length);
  return Object.fromEntries(entries);
}

describe("buildExecArgs", () => {
  test.each([
    { stdin: true, tty: true, flags: ["-it"] },
    { stdin: true, tty: false, flags: ["-i"] },
    { stdin: false, tty: true, flags: ["-t"] },
    { stdin: false, tty: false, flags: [] },
  ])("attaches stdin=$stdin and tty=$tty", ({ stdin, tty, flags }) => {
    const args = execArgs({ stdin, tty });
    expect(args.filter((arg) => ["-it", "-i", "-t"].includes(arg))).toEqual([
      ...flags,
    ]);
  });

  test("sets the working directory and forwards command arguments through the entrypoint", () => {
    const args = execArgs({
      currentDir: "/test/project/src",
      command: ["echo", "hello", "world"],
    });
    expect(args.slice(args.indexOf("-w"), args.indexOf("-w") + 2)).toEqual([
      "-w",
      "/test/project/src",
    ]);
    expect(args.slice(-5)).toEqual([
      "sandbox-test-a1b2",
      "/usr/local/bin/exec-entrypoint.sh",
      "echo",
      "hello",
      "world",
    ]);
    expect(args).not.toContain("-v");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("SANDBOX=1");
  });

  test.each([
    ["tmux-256color", "tmux-256color"],
    ["xterm-some-new-terminal", "xterm-256color"],
  ])("normalizes host TERM %s to %s", (host, expected) => {
    expect(environment(execArgs({}, { TERM: host })).TERM).toBe(expected);
  });

  test("keeps the last assignment, empty values, and embedded equals signs", () => {
    expect(
      environment(
        execArgs({
          environment: [
            "DUP=global",
            "EMPTY=",
            "EQUALS=a=b=c",
            "DUP=project",
            "DUP=cli",
          ],
        }),
      ),
    ).toEqual({ DUP: "cli", EMPTY: "", EQUALS: "a=b=c" });
  });

  test("does not resolve configured values again from the host", () => {
    expect(
      environment(
        execArgs(
          { environment: ["HERDR_PANE_ID=resolved"] },
          { HERDR_PANE_ID: "changed" },
        ),
      ),
    ).toEqual({ HERDR_PANE_ID: "resolved" });
  });

  test("available terminal values override configuration but missing or empty host values do not", () => {
    expect(
      environment(
        execArgs(
          {
            environment: [
              "TERM=user",
              "TZ=user-zone",
              "COLORTERM=user-color",
              "TERM_PROGRAM=user-program",
            ],
          },
          { TERM: "xterm-specific", COLORTERM: "truecolor", TERM_PROGRAM: "" },
        ),
      ),
    ).toEqual({
      TERM: "xterm-256color",
      TZ: "user-zone",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "user-program",
    });
  });

  test("managed proxy values override user values", () => {
    const env = environment(
      execArgs({
        proxyEnabled: true,
        environment: [
          "HTTP_PROXY=http://user",
          "NODE_USE_ENV_PROXY=0",
          "NO_PROXY=user",
        ],
      }),
    );
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8888");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.NO_PROXY).toContain("localhost");
    for (const name of [
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "GIT_SSH_COMMAND",
      "JAVA_TOOL_OPTIONS",
    ])
      expect(env[name]).toBeDefined();
  });

  test("disabled proxy mode does not inject overrides", () => {
    expect(environment(execArgs())).toEqual({});
    expect(
      environment(execArgs({ environment: ["HTTP_PROXY=http://user"] })),
    ).toEqual({ HTTP_PROXY: "http://user" });
  });

  test("injects managed host escape and debug values at the highest priority", () => {
    const env = environment(
      execArgs({
        environment: [
          "SANDBOX_HOST_COMMAND_ESCAPE_TOKEN=old",
          "SANDBOX_DEBUG=0",
        ],
        verbose: true,
        hostCommandEscapeEnvironment: {
          SANDBOX_HOST_COMMAND_ESCAPE_ENDPOINT:
            "ws://host.docker.internal:4321/session",
          SANDBOX_HOST_COMMAND_ESCAPE_PROTOCOL:
            "sandbox-host-command-escape.v1",
          SANDBOX_HOST_COMMAND_ESCAPE_TOKEN: "secret-token",
        },
      }),
    );
    expect(env).toEqual({
      SANDBOX_HOST_COMMAND_ESCAPE_ENDPOINT:
        "ws://host.docker.internal:4321/session",
      SANDBOX_HOST_COMMAND_ESCAPE_PROTOCOL: "sandbox-host-command-escape.v1",
      SANDBOX_HOST_COMMAND_ESCAPE_TOKEN: "secret-token",
      SANDBOX_DEBUG: "1",
    });
    expect(environment(execArgs()).SANDBOX_DEBUG).toBeUndefined();
  });
});
