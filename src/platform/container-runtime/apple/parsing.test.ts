import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExecError } from "#platform/process/index.js";
import {
  isMissingAppleResource,
  parseAppleContainer,
  parseAppleContainerArray,
} from "./parsing.js";

const fixturePath = path.join(
  import.meta.dir,
  "__fixtures__",
  "1.4.1",
  "container-list.json",
);

function readFixture(): string {
  return fs.readFileSync(fixturePath, "utf8");
}

describe("Apple container 1.4.1 parsing", () => {
  test("normalizes realistic list data, mounts, state, and start time", () => {
    const values = parseAppleContainerArray(readFixture(), "container list");
    const first = values[0];
    if (!first) throw new Error("Fixture has no first container.");

    expect(
      parseAppleContainer(
        first,
        () => "/Users/test/data/apple-container-volumes",
      ),
    ).toEqual({
      id: "sandbox-alpha",
      name: "sandbox-alpha",
      image: "sandbox-alpha:latest",
      imageIdentity:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      labels: {
        "sandbox.managed": "true",
        "sandbox.project": "alpha",
      },
      state: "running",
      startedAt: new Date("2026-09-11T12:00:00Z"),
      mounts: [
        {
          type: "bind",
          sourcePath: "/Users/test/project",
          targetPath: "/workspace",
          readOnly: true,
        },
        {
          type: "volume",
          volumeName: "cache",
          targetPath: "/var/cache",
          readOnly: false,
        },
      ],
    });
  });

  test("rejects malformed, incomplete, and invalid-date output", () => {
    expect(() =>
      parseAppleContainerArray("not-json", "container list"),
    ).toThrow("invalid container list JSON");
    expect(() => parseAppleContainerArray("[null]", "container list")).toThrow(
      "invalid container list data",
    );
    expect(() => parseAppleContainer({}, () => "/unused")).toThrow(
      "missing identity data",
    );
    expect(() =>
      parseAppleContainer(
        {
          configuration: {
            id: "broken",
            image: {
              reference: "image",
              descriptor: { digest: "sha256:image" },
            },
          },
          status: { startedDate: "not-a-date" },
        },
        () => "/unused",
      ),
    ).toThrow("invalid start date");
  });

  test("classifies only explicit Apple resource absence", () => {
    expect(
      isMissingAppleResource(
        new ExecError("failed", 1, {
          stderr: "Error: container not found: missing",
        }),
      ),
    ).toBe(true);
    expect(
      isMissingAppleResource(
        new ExecError("failed", 1, {
          stderr: "Apple container service is unavailable",
        }),
      ),
    ).toBe(false);
    expect(
      isMissingAppleResource(new Error("container not found: missing")),
    ).toBe(false);
  });
});
