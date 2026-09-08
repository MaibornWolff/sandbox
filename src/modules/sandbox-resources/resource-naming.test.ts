import { describe, expect, test } from "bun:test";
import {
  BASE_IMAGE,
  CACHE_VOLUME,
  getProjectImageName,
  getSandboxImageGlob,
  isLegacyName,
  LEGACY_CACHE_VOLUME,
  LEGACY_PREFIX,
  migrateDockerfileContent,
  migrateName,
  SANDBOX_PREFIX,
  USER_IMAGE,
} from "./resource-naming.js";

describe("naming constants", () => {
  test("SANDBOX_PREFIX is single dash", () => {
    expect(SANDBOX_PREFIX).toBe("sandbox-");
  });

  test("LEGACY_PREFIX is double dash", () => {
    expect(LEGACY_PREFIX).toBe("sandbox--");
  });

  test("BASE_IMAGE uses new prefix", () => {
    expect(BASE_IMAGE).toBe("sandbox-base:latest");
  });

  test("USER_IMAGE uses new prefix", () => {
    expect(USER_IMAGE).toBe("sandbox-user:latest");
  });

  test("CACHE_VOLUME uses new prefix", () => {
    expect(CACHE_VOLUME).toBe("sandbox-cache");
  });

  test("legacy constants use double dash", () => {
    expect(LEGACY_CACHE_VOLUME).toBe("sandbox--cache");
  });
});

describe("getProjectImageName", () => {
  test("returns image name with new prefix", () => {
    expect(getProjectImageName("myproject-ab12")).toBe(
      "sandbox-myproject-ab12:latest",
    );
  });
});

describe("getSandboxImageGlob", () => {
  test("returns glob with new prefix", () => {
    expect(getSandboxImageGlob()).toBe("sandbox-*");
  });
});

describe("isLegacyName", () => {
  test("detects legacy names", () => {
    expect(isLegacyName("sandbox--base:latest")).toBe(true);
    expect(isLegacyName("sandbox--cache")).toBe(true);
  });

  test("rejects new names", () => {
    expect(isLegacyName("sandbox-base:latest")).toBe(false);
    expect(isLegacyName("something-else")).toBe(false);
  });
});

describe("migrateName", () => {
  test("converts legacy to new name", () => {
    expect(migrateName("sandbox--base:latest")).toBe("sandbox-base:latest");
    expect(migrateName("sandbox--cache")).toBe("sandbox-cache");
    expect(migrateName("sandbox--myproject-ab12:latest")).toBe(
      "sandbox-myproject-ab12:latest",
    );
  });

  test("leaves new names unchanged", () => {
    expect(migrateName("sandbox-base:latest")).toBe("sandbox-base:latest");
    expect(migrateName("unrelated")).toBe("unrelated");
  });
});

describe("migrateDockerfileContent", () => {
  test("replaces legacy base image reference", () => {
    const input = "FROM sandbox--base:latest\nRUN echo hello";
    expect(migrateDockerfileContent(input)).toBe(
      "FROM sandbox-base:latest\nRUN echo hello",
    );
  });

  test("replaces legacy user image reference", () => {
    const input = "FROM sandbox--user:latest\nRUN echo hello";
    expect(migrateDockerfileContent(input)).toBe(
      "FROM sandbox-user:latest\nRUN echo hello",
    );
  });

  test("replaces both legacy references in one file", () => {
    const input =
      "FROM sandbox--base:latest AS base\nFROM sandbox--user:latest AS user";
    expect(migrateDockerfileContent(input)).toBe(
      "FROM sandbox-base:latest AS base\nFROM sandbox-user:latest AS user",
    );
  });

  test("returns content unchanged when no legacy references", () => {
    const input = "FROM sandbox-base:latest\nRUN echo hello";
    expect(migrateDockerfileContent(input)).toBe(input);
  });

  test("returns content unchanged for unrelated Dockerfiles", () => {
    const input = "FROM ubuntu:24.04\nRUN apt-get update";
    expect(migrateDockerfileContent(input)).toBe(input);
  });
});
