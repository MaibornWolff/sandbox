import chalk from "chalk";

export function formatTrustPrompt(): string {
  return `  ${chalk.yellow("Trust this project config?")} `;
}
