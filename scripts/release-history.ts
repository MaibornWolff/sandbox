import chalk from "chalk";
import { gitCommand } from "./release-command.js";

function isMinorRelease(message: string): boolean {
  const subject = message.split("\n")[0] ?? "";
  return (
    /^feat(?:\([^\r\n()]+\))?!?: /.test(subject) ||
    /^[a-z]+(?:\([^\r\n()]+\))?!: /.test(subject) ||
    /^BREAKING[ -]CHANGE: /m.test(message)
  );
}

export function releaseIncrementFromHistory(
  repoRoot: string,
  currentVersion: string,
): "minor" | "patch" {
  if (
    gitCommand(["rev-parse", "--is-shallow-repository"], repoRoot) === "true"
  ) {
    throw new Error(
      "Release version calculation requires full Git history and tags",
    );
  }
  const tag = `v${currentVersion}`;
  const tags = gitCommand(["tag", "--list", "v0.*"], repoRoot)
    .split("\n")
    .filter(Boolean);
  const hasBaseline = tags.includes(tag);
  if (!hasBaseline && tags.length > 0) {
    throw new Error(
      `Current version tag ${tag} is missing from release history`,
    );
  }
  if (hasBaseline) {
    gitCommand(["merge-base", "--is-ancestor", tag, "HEAD"], repoRoot);
  }
  const range = hasBaseline ? `${tag}..HEAD` : "HEAD";
  const messages = gitCommand(["log", "--format=%B%x00", range], repoRoot)
    .split("\0")
    .map((message) => message.trim())
    .filter(Boolean);
  if (messages.length === 0) throw new Error(`No commits since ${tag}`);
  const bump = messages.some(isMinorRelease) ? "minor" : "patch";
  console.error(
    `Selected ${chalk.bold(bump)} increment from ${messages.length} commits in ${chalk.cyan(range)}`,
  );
  return bump;
}
