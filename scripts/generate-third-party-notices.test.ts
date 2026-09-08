import { describe, expect, test } from "bun:test";
import { renderThirdPartyNotices } from "./generate-third-party-notices.js";

const mitText = "MIT License\n\nPermission is hereby granted.";

function createRecord(options: {
  readonly name: string;
  readonly version: string;
  readonly licenses?: string;
  readonly licenseText?: string;
  readonly noticeText?: string;
}) {
  return {
    name: options.name,
    version: options.version,
    licenses: options.licenses ?? "MIT",
    repository: `https://example.com/${options.name}`,
    copyright: `Copyright ${options.name}`,
    licenseText: options.licenseText ?? mitText,
    path: "",
    noticeText: options.noticeText ?? "",
  };
}

describe("renderThirdPartyNotices", () => {
  test("lists dependencies and deduplicates license texts", () => {
    const output = renderThirdPartyNotices(
      [
        createRecord({ name: "sandbox", version: "1.0.0" }),
        createRecord({ name: "beta", version: "2.0.0" }),
        createRecord({ name: "alpha", version: "1.0.0" }),
      ],
      {
        projectName: "sandbox",
        projectVersion: "1.0.0",
        generatedDate: "2026-08-18",
      },
    );

    expect(output).toContain("Product: sandbox");
    expect(output).toContain("Version: 1.0.0");
    expect(output).toContain("Generated: 2026-08-18");
    expect(output).toContain("| alpha | 1.0.0 | [MIT](#license-1)");
    expect(output).toContain("| beta | 2.0.0 | [MIT](#license-1)");
    expect(output).not.toContain("| sandbox |");
    expect(output.match(/### License 1/g)).toHaveLength(1);
  });

  test("includes package notices", () => {
    const output = renderThirdPartyNotices(
      [
        createRecord({
          name: "dependency",
          version: "1.2.3",
          noticeText: "Required attribution",
        }),
      ],
      {
        projectName: "sandbox",
        projectVersion: "1.0.0",
        generatedDate: "2026-08-18",
      },
    );

    expect(output).toContain("## Component Notices");
    expect(output).toContain("### dependency 1.2.3");
    expect(output).toContain("    Required attribution");
  });
});
