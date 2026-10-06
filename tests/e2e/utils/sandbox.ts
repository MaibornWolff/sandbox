import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getExitCodeForSignal } from "#platform/process/index.js";
import {
  buildTerminalCommandArgs,
  createE2eGlobalConfig,
  type SandboxResult,
  sanitizeSandboxOutput,
} from "#test/e2e-sandbox-helpers.js";

export { assertSandboxSuccess } from "#test/e2e-sandbox-helpers.js";

import { findExecutable } from "./executable.js";
import { log, logError, logLines } from "./log.js";

const SANDBOX_BIN = resolve(
  process.env.SANDBOX_BIN ?? "./dist/apps/sandbox/main.js",
);

interface SandboxOptions {
  binary?: string;
  cwd?: string;
  timeoutSeconds?: number;
  env?: Readonly<Record<string, string>>;
}

interface SandboxExecOptions {
  stdin?: string;
  timeoutSeconds?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

interface SandboxCommandInteraction {
  readonly result: Promise<SandboxResult>;
  sendSignal(signal: NodeJS.Signals): void;
  waitForOutput(expected: string, timeoutSeconds?: number): Promise<void>;
}

const DEFAULT_TIMEOUT = 20;
const NODE_CAPTURE_SCRIPT = `
const { spawn } = require("node:child_process");
const { closeSync, openSync, writeSync } = require("node:fs");
const { constants } = require("node:os");
const [stdinPath, stdoutPath, stderrPath, executable, ...args] = process.argv.slice(1);
const input = openSync(stdinPath, "r");
const output = openSync(stdoutPath, "w");
const errorOutput = openSync(stderrPath, "w");
const child = spawn(executable, args, {
  stdio: [input, output, errorOutput],
  windowsHide: true,
});
let failed = false;
child.once("error", (error) => {
  failed = true;
  writeSync(errorOutput, String(error) + "\\n");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("close", (exitCode, signal) => {
  closeSync(input);
  closeSync(output);
  closeSync(errorOutput);
  const signalNumber = signal ? constants.signals[signal] : undefined;
  process.exitCode = failed
    ? 1
    : exitCode ?? (typeof signalNumber === "number" ? 128 + signalNumber : 1);
});
`;

function spawnCapturedProcess(options: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly input?: string;
  readonly outputDirectory: string;
}) {
  const [executable, ...args] = options.command;
  if (!executable) throw new Error("Cannot start an empty E2E command.");
  const processDirectory = mkdtempSync(
    join(options.outputDirectory, "process-"),
  );
  const stdinPath = join(processDirectory, "stdin");
  const stdoutPath = join(processDirectory, "stdout");
  const stderrPath = join(processDirectory, "stderr");
  writeFileSync(stdinPath, options.input ?? "");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");

  // Bun cannot create child stdio descriptors after sandbox escape, so Node owns them.
  const child = spawn(
    nodeBin,
    [
      "--eval",
      NODE_CAPTURE_SCRIPT,
      "--",
      stdinPath,
      stdoutPath,
      stderrPath,
      executable,
      ...args,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    },
  );
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve(exitCode ?? (signal ? getExitCodeForSignal(signal) : 1));
    });
  });

  return {
    child,
    exited,
    readOutput: () => ({
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8"),
    }),
  };
}

function startSandboxCommand(options: {
  readonly binary: string;
  readonly args: string[];
  readonly cwd: string;
  readonly configDir: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly defaultTimeout: number;
  readonly execOptions: SandboxExecOptions;
}): SandboxCommandInteraction {
  const timeout = options.execOptions.timeoutSeconds ?? options.defaultTimeout;
  const command = ["sandbox", ...options.args];
  log(
    `→ ${command.join(" ")} (controlled, cwd: ${options.cwd}, timeout: ${timeout}s)`,
  );
  const startedAt = performance.now();
  const proc = spawnCapturedProcess({
    command: [options.binary, ...options.args],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      ...options.execOptions.env,
      SANDBOX_TRUST_ALL: "1",
      SANDBOX_CONFIG_DIR: options.configDir,
    },
    input: options.execOptions.stdin,
    outputDirectory: options.configDir,
  });

  const timeoutHandle = setTimeout(
    () => proc.child.kill("SIGKILL"),
    timeout * 1_000,
  );
  const result = proc.exited.then((exitCode) => {
    clearTimeout(timeoutHandle);
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const { stdout: rawStdout, stderr: rawStderr } = proc.readOutput();
    const commandResult: SandboxResult = {
      command,
      stdout: sanitizeSandboxOutput(rawStdout),
      stderr: sanitizeSandboxOutput(rawStderr),
      rawStdout,
      rawStderr,
      exitCode,
    };
    log(`← exit=${exitCode} (${elapsed}s)`);
    return commandResult;
  });

  return {
    result,
    sendSignal(signal): void {
      proc.child.kill(signal);
    },
    async waitForOutput(expected, timeoutSeconds = timeout): Promise<void> {
      const deadline = Date.now() + timeoutSeconds * 1_000;
      while (Date.now() < deadline) {
        const { stdout, stderr } = proc.readOutput();
        if (`${stdout}\n${stderr}`.includes(expected)) return;
        const completed = await Promise.race([
          result.then(() => true),
          Bun.sleep(50).then(() => false),
        ]);
        if (completed) break;
      }
      const { stdout, stderr } = proc.readOutput();
      throw new Error(
        `Timed out waiting for ${JSON.stringify(expected)} from ${command.join(" ")}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    },
  };
}

function resolveNodeBin(): string {
  const nodePath = findExecutable("node");
  if (nodePath) return nodePath;

  throw new Error("node command not found. Install Node.js 24 and retry.");
}

function resolveTimeoutBin(): string {
  const timeoutPath = findExecutable("timeout");
  if (timeoutPath) return timeoutPath;

  const gtimeoutPath = findExecutable("gtimeout");
  if (gtimeoutPath) return gtimeoutPath;

  throw new Error(
    "timeout command not found. Install coreutils (provides timeout/gtimeout) and retry.",
  );
}

const nodeBin = resolveNodeBin();
const timeoutBin = resolveTimeoutBin();

function resolveTerminalBin(): string {
  const scriptPath = findExecutable("script");
  if (scriptPath) return scriptPath;

  throw new Error(
    "script command not found. Install util-linux (provides script) and retry terminal E2E tests.",
  );
}

function createIsolatedHome(configDir: string): string {
  const homeDir = join(configDir, "home");
  for (const relativePath of [".agents/skills", ".claude/ide", ".codex"]) {
    mkdirSync(join(homeDir, relativePath), { recursive: true });
  }
  writeFileSync(join(homeDir, ".codex/auth.json"), "{}\n");
  return homeDir;
}

export function createSandbox(opts?: SandboxOptions) {
  const cwd = opts?.cwd ?? process.cwd();
  const defaultTimeout = opts?.timeoutSeconds ?? DEFAULT_TIMEOUT;

  // Keep bind-mounted fixtures under the E2E project. Colima shares
  // project paths but does not necessarily share the host OS temp directory.
  const configDir = mkdtempSync(join(cwd, ".sandbox-test-config-"));
  const homeDir = createIsolatedHome(configDir);
  const dockerConfigDir =
    opts?.env?.DOCKER_CONFIG ??
    process.env.DOCKER_CONFIG ??
    (process.env.HOME ? join(process.env.HOME, ".docker") : undefined);

  const templateConfigPath = process.env.SANDBOX_RUNTIME_ROOT
    ? resolve(process.env.SANDBOX_RUNTIME_ROOT, "templates/config.toml")
    : resolve(__dirname, "../../../templates/config.toml");
  createE2eGlobalConfig({
    templatePath: templateConfigPath,
    configPath: join(configDir, "config.toml"),
    runtime: process.env.SANDBOX_TEST_RUNTIME,
    appleDns: process.env.SANDBOX_TEST_APPLE_DNS,
  });

  async function execute(
    args: string[],
    execOptions: SandboxExecOptions,
    terminal: boolean,
  ): Promise<SandboxResult> {
    const timeout = execOptions.timeoutSeconds ?? defaultTimeout;
    const sandboxArgs = [...args];
    const commandArgs = [
      timeoutBin,
      String(timeout),
      opts?.binary ?? SANDBOX_BIN,
      ...sandboxArgs,
    ];
    const allArgs = terminal
      ? buildTerminalCommandArgs({
          scriptPath: resolveTerminalBin(),
          commandArgs,
          platform: process.platform,
        })
      : commandArgs;

    log(
      `→ sandbox ${sandboxArgs.join(" ")} (${terminal ? "terminal, " : ""}cwd: ${cwd}, timeout: ${timeout}s)`,
    );
    const start = performance.now();

    const proc = spawnCapturedProcess({
      command: allArgs,
      cwd,
      env: {
        ...process.env,
        ...opts?.env,
        ...execOptions.env,
        ...(dockerConfigDir ? { DOCKER_CONFIG: dockerConfigDir } : {}),
        HOME: homeDir,
        SANDBOX_TRUST_ALL: "1",
        SANDBOX_CONFIG_DIR: configDir,
      },
      input: execOptions.stdin,
      outputDirectory: configDir,
    });

    const exitCode = await proc.exited;
    const { stdout: stdoutBuf, stderr: stderrBuf } = proc.readOutput();
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);

    const result: SandboxResult = {
      command: ["sandbox", ...sandboxArgs],
      stdout: sanitizeSandboxOutput(stdoutBuf),
      stderr: sanitizeSandboxOutput(stderrBuf),
      rawStdout: stdoutBuf,
      rawStderr: stderrBuf,
      exitCode,
    };

    if (exitCode !== 0) {
      logError(`✗ exit=${exitCode} (${elapsed}s)`);
      logLines("stderr", result.rawStderr);
      logLines("stdout", result.rawStdout);
    } else {
      log(`✓ exit=0 (${elapsed}s)`);
    }

    return result;
  }

  function exec(
    args: string[],
    execOptions: SandboxExecOptions = {},
  ): Promise<SandboxResult> {
    return execute(args, execOptions, false);
  }

  function start(
    args: string[],
    execOptions: SandboxExecOptions = {},
  ): SandboxCommandInteraction {
    return startSandboxCommand({
      binary: opts?.binary ?? SANDBOX_BIN,
      args,
      cwd,
      configDir,
      env: {
        ...opts?.env,
        ...(dockerConfigDir ? { DOCKER_CONFIG: dockerConfigDir } : {}),
        HOME: homeDir,
      },
      defaultTimeout,
      execOptions,
    });
  }

  function execTerminal(args: string[]): Promise<SandboxResult> {
    return execute(args, {}, true);
  }

  return {
    configDir,
    exec,
    execTerminal,
    start,

    run(...cmd: string[]): Promise<SandboxResult> {
      return exec(["run", "--", ...cmd]);
    },

    runFullNetwork(...cmd: string[]): Promise<SandboxResult> {
      return exec(["--full-network", "run", "--", ...cmd]);
    },

    networkLogs(...args: string[]): Promise<SandboxResult> {
      return exec(["network", "logs", ...args]);
    },

    build(timeoutSeconds = 300): Promise<SandboxResult> {
      return exec(["build"], { timeoutSeconds });
    },

    stop(): Promise<SandboxResult> {
      return exec(["stop", "--force"], { timeoutSeconds: 30 });
    },
  };
}

export type SandboxInstance = ReturnType<typeof createSandbox>;

/** Check if a network failure is transient (DNS/timeout issues, not a security block). */
export function isTransientNetworkFailure(
  exitCode: number,
  output: string,
): boolean {
  if ([6, 7, 28, 124].includes(exitCode)) return true;
  if (
    /Could not resolve host|Temporary failure in name resolution|Failed to connect|Connection timed out|operation timed out/i.test(
      output,
    )
  )
    return true;
  return false;
}
