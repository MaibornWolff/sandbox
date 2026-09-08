import type { ProcessTestHarness } from "#platform/process/__test__/index.js";
import { getEditorDiffCommand } from "../editor.js";

export interface EditorFixture {
  prepare(): void;
  givenAvailableEditors(commands: readonly string[]): void;
  givenLaunchResult(options: {
    readonly command: string;
    readonly existingPath: string;
    readonly updatedPath: string;
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  }): void;
  acceptChanges(...paths: readonly string[]): void;
  cancel(): void;
  acceptedChanges(): readonly string[];
  launchedPaths(): readonly string[];
  output(): readonly { stdout: string; stderr: string; exitCode: number }[];
}

const KNOWN_EDITORS = ["code", "idea", "nvim", "vim", "vi"] as const;

export function createEditorFixture(options: {
  readonly processes: ProcessTestHarness;
  readonly platform: NodeJS.Platform;
  readonly environmentEditors?: readonly string[];
  readonly cancel?: () => void;
}): EditorFixture {
  const accepted = new Set<string>();
  const outcomes: Array<{ stdout: string; stderr: string; exitCode: number }> =
    [];
  const availabilityCommand = options.platform === "win32" ? "where" : "which";
  const candidates = new Set([
    ...KNOWN_EDITORS,
    ...(options.environmentEditors ?? []),
  ]);
  let available = new Set<string>();

  return {
    prepare() {
      for (let check = 0; check < 2; check += 1) {
        for (const command of candidates) {
          const process = options.processes.expectStart({
            match: { command: availabilityCommand, args: [command] },
          });
          process.resolveResult({
            exitCode: available.has(command) ? 0 : 1,
            stdout: available.has(command) ? `${command}\n` : "",
            stderr: "",
          });
        }
      }
    },
    givenAvailableEditors(commands) {
      available = new Set(commands);
    },
    givenLaunchResult(resultOptions) {
      const result = {
        exitCode: resultOptions.exitCode ?? 0,
        stdout: resultOptions.stdout ?? "",
        stderr: resultOptions.stderr ?? "",
      };
      outcomes.push(result);
      const command = getEditorDiffCommand(resultOptions.command)?.(
        resultOptions.existingPath,
        resultOptions.updatedPath,
      );
      if (!command?.[0]) {
        throw new Error(
          `Editor ${resultOptions.command} does not support diff launches.`,
        );
      }
      options.processes
        .expectStart({ match: { command: command[0], args: command.slice(1) } })
        .resolveResult(result);
    },
    acceptChanges(...paths) {
      for (const path of paths) accepted.add(path);
    },
    cancel: () => options.cancel?.(),
    acceptedChanges: () => [...accepted],
    launchedPaths() {
      return options.processes.requests
        .filter((request) =>
          KNOWN_EDITORS.includes(
            request.command as (typeof KNOWN_EDITORS)[number],
          ),
        )
        .flatMap((request) =>
          (request.args ?? []).filter(
            (argument) => !argument.startsWith("-") && argument !== "diff",
          ),
        );
    },
    output: () => outcomes.map((outcome) => ({ ...outcome })),
  };
}
