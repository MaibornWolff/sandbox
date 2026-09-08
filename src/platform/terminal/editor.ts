import * as path from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";
import { ExecError, getProcessManager } from "#platform/process/index.js";
import { getTerminal } from "./terminal.js";

interface EditorChoice {
  name: string;
  command: string;
  available: boolean;
}

const EXTRA_EDITORS: Omit<EditorChoice, "available">[] = [
  { name: "VS Code", command: "code" },
  { name: "IntelliJ IDEA", command: "idea" },
];

/** @lintignore Owner-local editor detection primitive covered by focused tests. */
export async function commandExists(command: string): Promise<boolean> {
  const environment = getHostEnvironment();
  const result = await getProcessManager().start({
    command: environment.platform === "win32" ? "where" : "which",
    args: [command],
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "ignore",
    signal: getTerminal().signal,
  }).result;
  return result.exitCode === 0;
}

async function tryAddEnvEditor(
  envValue: string | undefined,
  available: EditorChoice[],
  addedCommands: Set<string>,
): Promise<void> {
  if (!envValue) return;
  const commandName = path.basename(envValue);
  if (addedCommands.has(commandName) || addedCommands.has(envValue)) return;

  if ((await commandExists(envValue)) || (await commandExists(commandName))) {
    available.push({ name: commandName, command: envValue, available: true });
    addedCommands.add(commandName);
    addedCommands.add(envValue);
  }
}

/** @lintignore Owner-local editor selection primitive covered by focused tests. */
export async function getAvailableEditors(): Promise<EditorChoice[]> {
  const available: EditorChoice[] = [];
  const addedCommands = new Set<string>();
  const variables = getHostEnvironment().variables;

  await tryAddEnvEditor(variables.EDITOR, available, addedCommands);
  await tryAddEnvEditor(variables.VISUAL, available, addedCommands);

  for (const editor of EXTRA_EDITORS) {
    if (addedCommands.has(editor.command)) continue;
    if (await commandExists(editor.command)) {
      available.push({ ...editor, available: true });
      addedCommands.add(editor.command);
    }
  }
  return available;
}

const TERMINAL_EDITORS = ["vim", "nvim", "nano", "emacs", "vi"];

function isTerminalEditor(editor: string): boolean {
  return TERMINAL_EDITORS.includes(path.basename(editor));
}

const DIFF_CAPABLE_EDITORS: Record<string, (a: string, b: string) => string[]> =
  {
    code: (a, b) => [
      "code",
      "--new-window",
      "--disable-workspace-trust",
      "--diff",
      a,
      b,
      "--wait",
    ],
    idea: (a, b) => ["idea", "diff", a, b],
    nvim: (a, b) => ["nvim", "-d", a, b],
    vim: (a, b) => ["vim", "-d", a, b],
    vi: (a, b) => ["vi", "-d", a, b],
  };

export function getEditorDiffCommand(
  editor: string,
): ((a: string, b: string) => string[]) | null {
  return DIFF_CAPABLE_EDITORS[path.basename(editor)] ?? null;
}

const DIFF_EDITOR_SHADOWS: Record<string, string[]> = {
  nvim: ["vim", "vi"],
  vim: ["vi"],
};

/** @lintignore Owner-local editor normalization primitive covered by focused tests. */
export function removeShadowedEditors(
  editors: Array<{ name: string; command: string }>,
): Array<{ name: string; command: string }> {
  const shadowedNames = new Set<string>();
  for (const editor of editors) {
    for (const shadowed of DIFF_EDITOR_SHADOWS[editor.name] ?? []) {
      shadowedNames.add(shadowed);
    }
  }
  return editors.filter((editor) => !shadowedNames.has(editor.name));
}

export async function getAvailableDiffEditors(): Promise<
  Array<{ name: string; command: string }>
> {
  const results: Array<{ name: string; command: string }> = [];
  const addedCommands = new Set<string>();
  const variables = getHostEnvironment().variables;

  for (const envValue of [variables.EDITOR, variables.VISUAL]) {
    if (!envValue) continue;
    const basename = path.basename(envValue);
    if (addedCommands.has(basename)) continue;
    if (DIFF_CAPABLE_EDITORS[basename] && (await commandExists(envValue))) {
      results.push({ name: basename, command: envValue });
      addedCommands.add(basename);
    }
  }

  for (const editorName of Object.keys(DIFF_CAPABLE_EDITORS)) {
    if (addedCommands.has(editorName)) continue;
    if (await commandExists(editorName)) {
      const displayName =
        EXTRA_EDITORS.find((editor) => editor.command === editorName)?.name ??
        editorName;
      results.push({ name: displayName, command: editorName });
      addedCommands.add(editorName);
    }
  }

  return removeShadowedEditors(results);
}

function assertEditorSucceeded(
  command: string,
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
): void {
  if (result.exitCode === 0) return;
  throw new ExecError(
    `Editor ${command} exited with code ${result.exitCode}`,
    result.exitCode,
    result,
  );
}

export async function openDiffInEditor(
  existingPath: string,
  newPath: string,
  editor: string,
): Promise<boolean> {
  const diffCommand = getEditorDiffCommand(editor);
  if (!diffCommand) return true;

  const [command, ...args] = diffCommand(existingPath, newPath);
  if (!command) return true;
  const terminal = getTerminal();
  const terminalEditor = isTerminalEditor(editor);
  if (terminalEditor || args.includes("--wait")) {
    const manager = getProcessManager();
    const child = terminalEditor
      ? manager.start({
          command,
          args,
          lifetime: "application",
          interaction: { mode: "interactive" },
          stdio: "inherit",
          signal: terminal.signal,
        })
      : manager.start({
          command,
          args,
          lifetime: "application",
          interaction: { mode: "non-interactive" },
          stdio: "ignore",
          signal: terminal.signal,
        });
    assertEditorSucceeded(command, await child.result);
    return true;
  }

  const child = getProcessManager().start({
    command,
    args,
    lifetime: "detached",
    interaction: { mode: "non-interactive" },
    stdio: "ignore",
    stdin: "ignore",
    signal: terminal.signal,
  });
  void child.result.catch(() => undefined);
  return false;
}
