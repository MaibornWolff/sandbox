const VERSION_PATTERN = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UNRELEASED_HEADER = "## [Unreleased]";
// 0.71.0 is the unpublished baseline for the public release series.
const PUBLIC_BASELINE_MINOR = 71;

export function nextReleaseVersion(current: string, bump: string): string {
  const match = VERSION_PATTERN.exec(current);
  if (!match) throw new Error("Releases require a stable 0.x.y baseline");
  const minor = Number(match[1]);
  const patch = Number(match[2]);
  if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    throw new Error("Release version numbers must be safe integers");
  }
  if (minor < PUBLIC_BASELINE_MINOR) {
    throw new Error(
      `Public releases must be greater than 0.${PUBLIC_BASELINE_MINOR}.0`,
    );
  }
  if (bump === "patch" && Number.isSafeInteger(patch + 1)) {
    return `0.${minor}.${patch + 1}`;
  }
  if (bump === "minor" && Number.isSafeInteger(minor + 1)) {
    return `0.${minor + 1}.0`;
  }
  throw new Error("Select patch or minor for a pre-1.0 release");
}

export function validateReleaseDate(date: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Release date must be a valid YYYY-MM-DD date");
  }
}

export function prepareChangelog(options: {
  readonly changelog: string;
  readonly version: string;
  readonly date: string;
}): { readonly changelog: string; readonly notes: string } {
  validateReleaseDate(options.date);
  const lines = options.changelog.replaceAll("\r\n", "\n").split("\n");
  const unreleased = lines.flatMap((line, index) =>
    line === UNRELEASED_HEADER ? [index] : [],
  );
  const start = unreleased[0];
  if (unreleased.length !== 1 || start === undefined) {
    throw new Error(
      "CHANGELOG.md must contain exactly one ## [Unreleased] section",
    );
  }
  if (lines.slice(0, start).some((line) => line.startsWith("## "))) {
    throw new Error("Unreleased must be the first changelog section");
  }
  if (lines.some((line) => line.startsWith(`## [${options.version}]`))) {
    throw new Error(`CHANGELOG.md already contains version ${options.version}`);
  }
  const nextSection = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  const end = nextSection < 0 ? lines.length : nextSection;
  const notes = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  const withoutComments = notes.replace(/<!--[\s\S]*?-->/g, "");
  if (!/^[-*] \S/m.test(withoutComments)) {
    throw new Error(
      "Unreleased must contain at least one user-visible changelog entry",
    );
  }
  const prefix = lines.slice(0, start).join("\n").trimEnd();
  const history = lines.slice(end).join("\n").trim();
  const sections = [
    prefix,
    UNRELEASED_HEADER,
    `## [${options.version}] - ${options.date}\n\n${notes}`,
  ];
  if (history) sections.push(history);
  return { changelog: `${sections.join("\n\n")}\n`, notes: `${notes}\n` };
}
