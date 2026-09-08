import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessTestHarness } from "#platform/process/__test__/index.js";
import type {
  ProcessResult,
  StartProcessRequest,
} from "#platform/process/index.js";

export interface AgentExecutableMetadata {
  readonly name: string;
  readonly command: string;
  readonly path: string;
}

export interface AgentLaunchObservation {
  readonly executable: AgentExecutableMetadata;
  readonly args: readonly string[];
  readonly stdio: StartProcessRequest["stdio"];
}

export interface AssistanceFixture {
  givenExecutable(agent: {
    readonly name: string;
    readonly command: string;
  }): AgentExecutableMetadata;
  givenMissingExecutable(command: string): void;
  givenLaunchResult(result?: Partial<ProcessResult>): void;
  givenLaunchFailure(error: Error): void;
  executables(): readonly AgentExecutableMetadata[];
  launches(): readonly AgentLaunchObservation[];
  launchResults(): readonly (ProcessResult | Error)[];
}

export function createAssistanceFixture(options: {
  readonly executableDirectory: string;
  readonly processes: ProcessTestHarness;
  readonly platform: NodeJS.Platform;
}): AssistanceFixture {
  const metadata = new Map<string, AgentExecutableMetadata>();
  const launchOutcomes: Array<ProcessResult | Error> = [];
  fs.mkdirSync(options.executableDirectory, { recursive: true });

  function executablePath(command: string): string {
    const extension = options.platform === "win32" ? ".exe" : "";
    return path.join(options.executableDirectory, `${command}${extension}`);
  }

  return {
    givenExecutable(agent) {
      const filePath = executablePath(agent.command);
      fs.writeFileSync(filePath, "agent executable fixture");
      if (options.platform !== "win32") fs.chmodSync(filePath, 0o755);
      const executable = { ...agent, path: filePath };
      metadata.set(agent.command, executable);
      return executable;
    },
    givenMissingExecutable(command) {
      fs.rmSync(executablePath(command), { force: true });
      metadata.delete(command);
    },
    givenLaunchResult(partial = {}) {
      const result: ProcessResult = {
        exitCode: partial.exitCode ?? 0,
        stdout: partial.stdout ?? "",
        stderr: partial.stderr ?? "",
        ...(partial.signal ? { signal: partial.signal } : {}),
      };
      launchOutcomes.push(result);
      options.processes
        .expectStart({ match: { stdio: "inherit" } })
        .resolveResult(result);
    },
    givenLaunchFailure(error) {
      launchOutcomes.push(error);
      options.processes
        .expectStart({ match: { stdio: "inherit" } })
        .rejectResult(error);
    },
    executables: () => [...metadata.values()].map((entry) => ({ ...entry })),
    launches() {
      return options.processes.actions().flatMap((action) => {
        if (action.type !== "start") return [];
        const executable = metadata.get(action.request.command);
        if (!executable) return [];
        return [
          {
            executable: { ...executable },
            args: [...(action.request.args ?? [])],
            stdio: action.request.stdio,
          },
        ];
      });
    },
    launchResults: () => [...launchOutcomes],
  };
}
