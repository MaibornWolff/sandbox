import chalk from "chalk";

function escapeDisplayCharacter(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

export function formatConfigPath(value: string): string {
  return chalk.dim(
    JSON.stringify(value).replace(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
      escapeDisplayCharacter,
    ),
  );
}
