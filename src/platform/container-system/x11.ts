import { getSandboxEnvironment } from "#platform/environment/index.js";
import { executeContainerCommand } from "./command.js";

interface ContainerX11Diagnostic {
  readonly exitCode: number;
  readonly output: string;
}

export async function diagnoseContainerX11(): Promise<ContainerX11Diagnostic> {
  const display = getSandboxEnvironment().variables.DISPLAY;
  if (!display) {
    return { exitCode: 1, output: "❌ DISPLAY not set\n" };
  }

  try {
    const details = await executeContainerCommand("xdpyinfo", []);
    const lines = details.split("\n");
    const screenIndex = lines.findIndex((line) => line.startsWith("screen #0"));
    const screenDetails =
      screenIndex >= 0
        ? `${lines.slice(screenIndex, screenIndex + 3).join("\n")}\n`
        : "";
    return {
      exitCode: 0,
      output: `✅ X11 connection successful\n   Display: ${display}\n${screenDetails}`,
    };
  } catch (error) {
    if (
      "code" in Object(error) &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { exitCode: 1, output: "❌ xdpyinfo not installed\n" };
    }
    return {
      exitCode: 1,
      output: `❌ Cannot connect to X server at ${display}\n`,
    };
  }
}
