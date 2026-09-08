import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface LicenseRecord {
  readonly name: string;
  readonly version: string;
  readonly licenses: string;
  readonly repository: string;
  readonly copyright: string;
  readonly licenseText: string;
  readonly path: string;
  readonly noticeText: string;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function findNoticeText(packagePath: string): Promise<string> {
  if (!packagePath) return "";
  const entries = await readdir(packagePath);
  const noticeFile = entries.find((entry) => /^notice(?:\..*)?$/i.test(entry));
  if (!noticeFile) return "";
  return (await readFile(path.join(packagePath, noticeFile), "utf8")).trim();
}

async function parseReport(value: unknown): Promise<LicenseRecord[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("License report must be a JSON object");
  }

  return Promise.all(
    Object.values(value).map(async (entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("License report entries must be JSON objects");
      }
      const raw = entry as Record<string, unknown>;
      const name = readString(raw.name);
      const version = readString(raw.version);
      const licenses = readString(raw.licenses);
      const licenseText = readString(raw.licenseText);
      if (!name || !version || !licenses || !licenseText) {
        throw new Error(
          `Incomplete license data for ${name || "unknown package"}@${version || "unknown version"}`,
        );
      }
      const packagePath = readString(raw.path);
      return {
        name,
        version,
        licenses,
        repository: readString(raw.repository),
        copyright: readString(raw.copyright),
        licenseText,
        path: packagePath,
        noticeText: await findNoticeText(packagePath),
      };
    }),
  );
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function indentText(value: string): string {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

interface NoticeDocumentOptions {
  readonly projectName: string;
  readonly projectVersion: string;
  readonly generatedDate: string;
}

export function renderThirdPartyNotices(
  records: readonly LicenseRecord[],
  options: NoticeDocumentOptions,
): string {
  const dependencies = records
    .filter((record) => record.name !== options.projectName)
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    );
  const licenseTexts = [
    ...new Set(dependencies.map(({ licenseText }) => licenseText)),
  ];
  const licenseNumber = new Map(
    licenseTexts.map((licenseText, index) => [licenseText, index + 1]),
  );
  const lines = [
    "# Third-Party Notices",
    "",
    `Product: ${options.projectName}`,
    "",
    `Version: ${options.projectVersion}`,
    "",
    `Generated: ${options.generatedDate}`,
    "",
    "This product includes the open-source components listed below.",
    "",
    "| Component | Version | License | Copyright | Repository |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const record of dependencies) {
    const number = licenseNumber.get(record.licenseText);
    lines.push(
      `| ${escapeTableCell(record.name)} | ${escapeTableCell(record.version)} | [${escapeTableCell(record.licenses)}](#license-${number}) | ${escapeTableCell(record.copyright)} | ${escapeTableCell(record.repository)} |`,
    );
  }

  lines.push("", "## License Texts");
  for (const [index, licenseText] of licenseTexts.entries()) {
    lines.push("", `### License ${index + 1}`, "", indentText(licenseText));
  }

  const notices = dependencies.filter(({ noticeText }) => noticeText);
  if (notices.length > 0) lines.push("", "## Component Notices");
  for (const record of notices) {
    lines.push(
      "",
      `### ${record.name} ${record.version}`,
      "",
      indentText(record.noticeText),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const [inputPath, outputPath, projectName, projectVersion] =
    process.argv.slice(2);
  if (!inputPath || !outputPath || !projectName || !projectVersion) {
    throw new Error(
      "Usage: generate-third-party-notices <license-report.json> <output.md> <project-name> <project-version>",
    );
  }
  const report = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  const records = await parseReport(report);
  await writeFile(
    outputPath,
    renderThirdPartyNotices(records, {
      projectName,
      projectVersion,
      generatedDate: new Date().toISOString().slice(0, 10),
    }),
  );
}

const entryPoint = process.argv[1];
if (entryPoint && fileURLToPath(import.meta.url) === path.resolve(entryPoint)) {
  await main();
}
