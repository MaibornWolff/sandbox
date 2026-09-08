import { getProcessManager } from "#platform/process/index.js";
import {
  detectX11ForHostExecution,
  type HostEnvironment,
} from "./host-environment.js";
import type { X11Config } from "./x11-config.js";

interface XHostAccess {
  readonly configured: boolean;
  readonly method: string | null;
}

function unavailable(environment: HostEnvironment): X11Config {
  return {
    available: false,
    display: null,
    socketPath: null,
    platform: environment.platform as X11Config["platform"],
  };
}

async function commandSucceeds(
  command: string,
  args: readonly string[] = [],
): Promise<boolean> {
  try {
    return (
      (
        await getProcessManager().start({
          command,
          args,
          lifetime: "application",
          interaction: { mode: "non-interactive" },
        }).result
      ).exitCode === 0
    );
  } catch {
    return false;
  }
}

async function commandOutput(
  command: string,
  args: readonly string[] = [],
): Promise<string | null> {
  try {
    const result = await getProcessManager().start({
      command,
      args,
      lifetime: "application",
      interaction: { mode: "non-interactive" },
    }).result;
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

async function detectDarwin(config: X11Config): Promise<X11Config> {
  const xQuartzProcess = await commandOutput("pgrep", [
    "-ix",
    "XQuartz|X11\\.bin",
  ]);
  if (xQuartzProcess?.trim()) {
    return {
      ...config,
      available: true,
      display: ":0",
      socketPath: "/tmp/.X11-unix/X0",
    };
  }
  if (!(await commandSucceeds("test", ["-e", "/tmp/.X11-unix/X0"]))) {
    return config;
  }
  return {
    ...config,
    available: true,
    display: ":0",
    socketPath: "/tmp/.X11-unix/X0",
  };
}

async function detectLinux(
  config: X11Config,
  environment: HostEnvironment,
): Promise<X11Config> {
  const display = environment.variables.DISPLAY;
  const displayNumber = display?.match(/:(\d+)/)?.[1];
  if (!display || !displayNumber) return config;
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  const available =
    (await commandSucceeds("test", ["-e", socketPath])) ||
    (await commandSucceeds("xdpyinfo"));
  return available ? { ...config, available, display, socketPath } : config;
}

async function detectWindows(config: X11Config): Promise<X11Config> {
  for (const executable of ["vcxsrv.exe", "Xming.exe"]) {
    const output = await commandOutput("tasklist", [
      "/FI",
      `IMAGENAME eq ${executable}`,
    ]);
    if (output?.toLowerCase().includes(executable.toLowerCase())) {
      return { ...config, available: true, display: ":0" };
    }
  }
  return config;
}

async function detectX11Uncached(
  environment: HostEnvironment,
): Promise<X11Config> {
  const config = unavailable(environment);
  switch (environment.platform) {
    case "darwin":
      return detectDarwin(config);
    case "linux":
      return detectLinux(config, environment);
    case "win32":
      return detectWindows(config);
    default:
      return config;
  }
}

/** Detect X11 once for the current host application execution. */
export function detectX11(): Promise<X11Config> {
  return detectX11ForHostExecution(detectX11Uncached);
}

export async function checkXHostAccess(): Promise<XHostAccess> {
  const x11Config = await detectX11();
  if (!x11Config.available) return { configured: false, method: null };
  if (x11Config.platform === "win32") {
    return { configured: true, method: "windows-default" };
  }
  const output = await commandOutput("xhost");
  if (!output) return { configured: false, method: null };
  const methods: readonly [string, string][] = [
    ["access control disabled", "disabled"],
    ["localhost", "localhost"],
    ["127.0.0.1", "localhost"],
    ["SI:localuser:", "localuser"],
    ["host.docker.internal", "host.docker.internal"],
    ["host.lima.internal", "host.lima.internal"],
    ["host.containers.internal", "host.containers.internal"],
  ];
  const match = methods.find(([text]) => output.includes(text));
  return match
    ? { configured: true, method: match[1] }
    : { configured: false, method: null };
}

export async function isXQuartzInstalled(): Promise<boolean> {
  return (
    (await commandSucceeds("test", [
      "-d",
      "/Applications/Utilities/XQuartz.app",
    ])) || (await commandSucceeds("which", ["xquartz"]))
  );
}

export async function isXQuartzNetworkAccessEnabled(): Promise<boolean> {
  const output = await commandOutput("defaults", [
    "read",
    "org.xquartz.X11",
    "nolisten_tcp",
  ]);
  return output?.trim() === "0";
}

export async function isXQuartzRestartNeeded(): Promise<boolean> {
  const output = await commandOutput("ps", ["aux"]);
  return (
    output
      ?.split("\n")
      .some(
        (line) => line.includes("Xquartz :0") && line.includes("-nolisten tcp"),
      ) ?? false
  );
}

export async function isWindowsXServerInstalled(): Promise<boolean> {
  const output = await commandOutput("tasklist");
  return ["vcxsrv.exe", "xming.exe"].some((name) =>
    output?.toLowerCase().includes(name),
  );
}
