import { expect, test } from "bun:test";
import {
  nextReleaseVersion,
  prepareChangelog,
  validateReleaseDate,
} from "./release-state.js";

const changelog =
  "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A feature.\n\n### Breaking Changes\n\n- Use the new flag instead of the old flag.\n\n## [0.71.0] - 2026-01-01\n\n- Previous notes.\n";

function prepare(content = changelog) {
  return prepareChangelog({
    changelog: content,
    version: "0.72.0",
    date: "2026-10-08",
  });
}

test("increments minor for features and breaking changes without entering 1.x", () => {
  expect(nextReleaseVersion("0.71.0", "minor")).toBe("0.72.0");
  expect(nextReleaseVersion("0.71.9", "minor")).toBe("0.72.0");
  expect(nextReleaseVersion("0.99.0", "minor")).toBe("0.100.0");
});

test("increments patch for compatible fixes", () => {
  expect(nextReleaseVersion("0.71.0", "patch")).toBe("0.71.1");
  expect(nextReleaseVersion("0.72.1", "patch")).toBe("0.72.2");
});

test.each([
  "1.70.0",
  "0.0.0-development",
  "0.070.0",
  "0.70.9",
  "0.9007199254740992.0",
])("rejects an invalid public baseline: %s", (version) => {
  expect(() => nextReleaseVersion(version, "minor")).toThrow();
});

test("rejects major increments before an explicit stable-release policy", () => {
  expect(() => nextReleaseVersion("0.71.0", "major")).toThrow("patch or minor");
});

test("dates curated notes, preserves history, and leaves a new empty Unreleased section", () => {
  const prepared = prepare();
  expect(prepared.changelog).toContain(
    "## [Unreleased]\n\n## [0.72.0] - 2026-10-08",
  );
  expect(prepared.notes).toBe(
    "### Added\n\n- A feature.\n\n### Breaking Changes\n\n- Use the new flag instead of the old flag.\n",
  );
  expect(prepared.changelog).toEndWith(
    "## [0.71.0] - 2026-01-01\n\n- Previous notes.\n",
  );
});

test("normalizes Windows line endings", () => {
  expect(prepare(changelog.replaceAll("\n", "\r\n"))).toEqual(prepare());
});

test.each([
  "# Changelog\n",
  "## [Unreleased]\n\n## [Unreleased]\n- Entry",
  "## [0.71.0]\n\n## [Unreleased]\n- Entry",
])(
  "rejects a missing, duplicate, or misplaced Unreleased section",
  (content) => {
    expect(() => prepare(content)).toThrow();
  },
);

test("rejects empty notes and commented-out entries", () => {
  expect(() =>
    prepare("## [Unreleased]\n\n### Fixed\n\n<!--\n- Pending.\n-->\n"),
  ).toThrow("user-visible");
});

test("rejects a duplicate release version", () => {
  expect(() =>
    prepare(`${changelog}\n## [0.72.0] - 2026-02-01\n- Published\n`),
  ).toThrow("already contains");
});

test.each(["2026-02-30", "2026-13-01", "today", "2026-1-1"])(
  "rejects invalid release date %s",
  (date) => {
    expect(() => validateReleaseDate(date)).toThrow("valid YYYY-MM-DD");
  },
);
