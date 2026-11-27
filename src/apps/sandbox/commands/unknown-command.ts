import type { Command } from "commander";

const MAX_DISTANCE = 3;
const MIN_SIMILARITY = 0.4;

/**
 * Count the single-character edits between two words.
 * A swap of two adjacent characters counts as one edit.
 */
function editDistance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : i)),
  );
  const at = (i: number, j: number): number => rows[i]?.[j] ?? 0;

  for (let i = 1; i <= a.length; i++) {
    const row = rows[i];
    if (!row) continue;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let distance = Math.min(
        at(i - 1, j) + 1,
        at(i, j - 1) + 1,
        at(i - 1, j - 1) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance = Math.min(distance, at(i - 2, j - 2) + 1);
      }
      row[j] = distance;
    }
  }
  return at(a.length, b.length);
}

function findSimilarNames(word: string, candidates: string[]): string[] {
  let similar: string[] = [];
  let bestDistance = MAX_DISTANCE;
  for (const candidate of new Set(candidates)) {
    const distance = editDistance(word, candidate);
    const length = Math.max(word.length, candidate.length);
    if ((length - distance) / length <= MIN_SIMILARITY) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      similar = [candidate];
    } else if (distance === bestDistance) {
      similar.push(candidate);
    }
  }
  return similar.sort((a, b) => a.localeCompare(b));
}

/**
 * Exit with an unknown-command error for a subcommand name of `parent`.
 *
 * Commander makes this report only for commands without an action or default
 * subcommand. The message format matches the Commander format.
 */
export function rejectUnknownCommand(parent: Command, name: string): never {
  const candidates = parent
    .createHelp()
    .visibleCommands(parent)
    .flatMap((command) => [command.name(), ...command.aliases()])
    .filter((candidate) => candidate.length > 1);
  const similar = findSimilarNames(name, candidates);

  let suggestion = "";
  if (similar.length === 1) {
    suggestion = `\n(Did you mean ${similar[0]}?)`;
  } else if (similar.length > 1) {
    suggestion = `\n(Did you mean one of ${similar.join(", ")}?)`;
  }
  return parent.error(`error: unknown command '${name}'${suggestion}`);
}
