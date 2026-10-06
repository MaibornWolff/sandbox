import { describe, expect, test } from "bun:test";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { buildSandboxExecSpec } from "./session-arguments.js";

type ExecOptions = Parameters<typeof buildSandboxExecSpec>[0];

function execSpec(
  options: Partial<ExecOptions> = {},
  variables: Readonly<Record<string, string>> = {},
) {
  return runWithTestLogger(
    () =>
      buildSandboxExecSpec({
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

function environment(
  result: ReturnType<typeof execSpec>,
): Readonly<Record<string, string>> {
  return result.spec.environment ?? {};
}

describe("buildSandboxExecSpec", () => {
  test.each([
    { stdin: true, tty: true },
    { stdin: true, tty: false },
    { stdin: false, tty: true },
    { stdin: false, tty: false },
  ])("attaches stdin=$stdin and tty=$tty", ({ stdin, tty }) => {
    expect(execSpec({ stdin, tty }).session).toEqual({
      attachStdin: stdin,
      allocateTerminal: tty,
    });
  });

  test("sets the working directory and forwards command arguments through the entrypoint", () => {
    const result = execSpec({
      currentDir: "/test/project/src",
      command: ["echo", "hello", "world"],
    });
    expect(result.spec.workingDirectory).toBe("/test/project/src");
    expect(result.spec.command).toEqual([
      "/usr/local/bin/exec-entrypoint.sh",
      "echo",
      "hello",
      "world",
    ]);
    expect(environment(result)).not.toHaveProperty("SANDBOX");
  });

  test.each([
    ["tmux-256color", "tmux-256color"],
    ["xterm-some-new-terminal", "xterm-256color"],
  ])("normalizes host TERM %s to %s", (host, expected) => {
    expect(environment(execSpec({}, { TERM: host })).TERM).toBe(expected);
  });

  test("keeps the last assignment, empty values, and embedded equals signs", () => {
    expect(
      environment(
        execSpec({
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
        execSpec(
          { environment: ["HERDR_PANE_ID=resolved"] },
          { HERDR_PANE_ID: "changed" },
        ),
      ),
    ).toEqual({ HERDR_PANE_ID: "resolved" });
  });

  test("available terminal values override configuration but missing or empty host values do not", () => {
    expect(
      environment(
        execSpec(
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
      execSpec({
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
    expect(environment(execSpec())).toEqual({});
    expect(
      environment(execSpec({ environment: ["HTTP_PROXY=http://user"] })),
    ).toEqual({ HTTP_PROXY: "http://user" });
  });

  test("injects managed host escape and debug values at the highest priority", () => {
    const env = environment(
      execSpec({
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
    expect(environment(execSpec()).SANDBOX_DEBUG).toBeUndefined();
  });
});
