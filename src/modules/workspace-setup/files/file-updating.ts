import * as path from "node:path";
import chalk from "chalk";
import {
  createFile as createFileUtil,
  createTemporaryDirectory,
  type FileResult,
  pathExists,
  readTextFile,
  removePath,
  writeTextFile,
} from "#platform/filesystem/index.js";
import {
  getAvailableDiffEditors,
  getEditorDiffCommand,
  openDiffInEditor,
  selectOne,
  writeStandardOutput,
} from "#platform/terminal/index.js";
import {
  generateUnifiedDiff,
  printColoredDiff,
} from "./file-diff-rendering.js";
import type { FileDefinition } from "./generated-file-definition.js";

/**
 * Throw if a file write returned an error.
 */
function assertFileWritten(result: FileResult): void {
  if (result.error) {
    throw new Error(`Failed to write ${result.path}: ${result.error}`);
  }
}

type UpdateAction = string | "overwrite" | "skip";

interface FileUpdateResult {
  name: string;
  path: string;
  action: "created" | "updated" | "up-to-date" | "skipped";
}

/**
 * Write content to a temp file and return its path.
 * @testonly
 */
export function writeTempFile(name: string, content: string): string {
  const tmpDir = createTemporaryDirectory("sandbox-update-");
  const tmpPath = path.join(tmpDir, name.replace(/\//g, "-"));
  writeTextFile(tmpPath, content);
  return tmpPath;
}

/**
 * Clean up a temp file and its parent directory.
 * @testonly
 */
export function cleanupTempFile(tmpPath: string): void {
  try {
    removePath(path.dirname(tmpPath));
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Display a visual separator for a file section.
 * @testonly
 */
export function displayFileSeparator(name: string): void {
  const line = "─".repeat(50);
  writeStandardOutput(
    `${chalk.dim("──")} ${chalk.bold(name)} ${chalk.dim(line)}`,
  );
  writeStandardOutput();
}

/**
 * Prompt user for what to do with a changed file.
 */
async function promptUpdateAction(fileName: string): Promise<UpdateAction> {
  const diffEditors = await getAvailableDiffEditors();

  const choices: Array<{ name: string; value: UpdateAction }> = [];

  for (const editor of diffEditors) {
    const diffCmd = getEditorDiffCommand(editor.command);
    const cmdPreview = diffCmd ? `${editor.command} -d` : editor.command;
    choices.push({
      name: `Open diff in ${editor.name} ${chalk.dim(`(${cmdPreview})`)}`,
      value: editor.command,
    });
  }

  choices.push(
    { name: "Overwrite", value: "overwrite" },
    { name: "Skip", value: "skip" },
  );

  return selectOne({
    message: `Do you want to update ${fileName}?`,
    choices,
  });
}

/**
 * Process a single file for update (diff UX).
 * - File missing → create silently, return 'created'
 * - File identical → print "up to date", return 'up-to-date'
 * - File differs → show diff + prompt, return 'updated' | 'skipped'
 * @testonly
 */
export async function processFileUpdate(
  def: FileDefinition,
  toolIds: string[],
  requestedAction?: UpdateAction,
): Promise<FileUpdateResult> {
  const existingPath = def.getPath();
  const newContent = def.getTemplate(toolIds);
  const result: FileUpdateResult = {
    name: def.name,
    path: existingPath,
    action: "created",
  };

  // Case 1: File doesn't exist — create silently
  if (!pathExists(existingPath)) {
    assertFileWritten(
      createFileUtil(existingPath, newContent, { force: true }),
    );
    writeStandardOutput(`${chalk.green("✓")} Created ${existingPath}`);
    return result;
  }

  // Case 2: File identical
  const existingContent = readTextFile(existingPath);
  if (existingContent === newContent) {
    writeStandardOutput(`  ${chalk.green("✓")} Already up to date.`);
    writeStandardOutput();
    result.action = "up-to-date";
    return result;
  }

  // Case 3: File differs — show diff and prompt
  const diff = generateUnifiedDiff(
    existingContent,
    newContent,
    "current",
    "updated",
  );
  printColoredDiff(diff);
  writeStandardOutput();

  const action = requestedAction ?? (await promptUpdateAction(def.name));

  if (action === "overwrite") {
    assertFileWritten(
      createFileUtil(existingPath, newContent, { force: true }),
    );
    writeStandardOutput(`${chalk.green("✓")} Updated ${def.name}`);
    result.action = "updated";
  } else if (action === "skip") {
    writeStandardOutput(chalk.dim("  Skipped."));
    result.action = "skipped";
  } else {
    // action is an editor command string — open diff in editor
    const ext = path.extname(def.name);
    const base = def.name.slice(0, -ext.length || undefined);
    const tmpName = ext ? `${base}.updated${ext}` : `${def.name}.updated`;
    const tmpPath = writeTempFile(tmpName, newContent);
    const blocked = await openDiffInEditor(existingPath, tmpPath, action);
    // Only clean up temp file if the editor blocked (waited for close).
    // Non-blocking GUI editors need the file to remain until they read it.
    if (blocked) {
      cleanupTempFile(tmpPath);
    }
    result.action = "updated";
  }
  writeStandardOutput();

  return result;
}

/**
 * Process multiple file definitions with diff UX.
 *
 * - If NO file exists yet (first-time): create all silently, print "✓ Created" per file
 * - If ANY file exists (re-run): show separator per file + full diff UX
 */
export async function processFileUpdates(
  definitions: FileDefinition[],
  toolIds: string[],
): Promise<FileUpdateResult[]> {
  const anyExists = definitions.some((def) => pathExists(def.getPath()));

  writeStandardOutput(chalk.bold("Configuration files:\n"));

  if (!anyExists) {
    return createFilesSilently(definitions, toolIds);
  }

  // Re-run: show separator per file + diff UX
  const results: FileUpdateResult[] = [];
  for (const def of definitions) {
    displayFileSeparator(def.name);
    const result = await processFileUpdate(def, toolIds);
    results.push(result);
  }
  return results;
}

/**
 * Create all files silently without prompts (for non-interactive mode).
 */
export function createFilesSilently(
  definitions: FileDefinition[],
  toolIds: string[],
): FileUpdateResult[] {
  const results: FileUpdateResult[] = [];
  for (const def of definitions) {
    const filePath = def.getPath();
    const content = def.getTemplate(toolIds);
    assertFileWritten(createFileUtil(filePath, content, { force: true }));
    writeStandardOutput(`${chalk.green("✓")} Created ${filePath}`);
    results.push({ name: def.name, path: filePath, action: "created" });
  }
  return results;
}
