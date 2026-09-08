import { describe, expect, test } from "bun:test";
import { parseSizeToBytes } from "./size.js";

describe("parseSizeToBytes", () => {
  test("parses bytes", () => {
    expect(parseSizeToBytes("500B")).toBe(500);
    expect(parseSizeToBytes("0B")).toBe(0);
  });

  test("parses kilobytes", () => {
    expect(parseSizeToBytes("1KB")).toBe(1000);
    expect(parseSizeToBytes("1.5KB")).toBe(1500);
  });

  test("parses megabytes", () => {
    expect(parseSizeToBytes("1MB")).toBe(1000000);
    expect(parseSizeToBytes("1.5MB")).toBe(1500000);
    expect(parseSizeToBytes("100MB")).toBe(100000000);
  });

  test("parses gigabytes", () => {
    expect(parseSizeToBytes("1GB")).toBe(1000000000);
    expect(parseSizeToBytes("2GB")).toBe(2000000000);
    expect(parseSizeToBytes("2.5GB")).toBe(2500000000);
  });

  test("parses terabytes", () => {
    expect(parseSizeToBytes("1TB")).toBe(1000000000000);
  });

  test("handles case insensitivity", () => {
    expect(parseSizeToBytes("1mb")).toBe(1000000);
    expect(parseSizeToBytes("1Mb")).toBe(1000000);
    expect(parseSizeToBytes("1MB")).toBe(1000000);
  });

  test("returns 0 for invalid input", () => {
    expect(parseSizeToBytes("")).toBe(0);
    expect(parseSizeToBytes("invalid")).toBe(0);
    expect(parseSizeToBytes("123")).toBe(0);
    expect(parseSizeToBytes("MB")).toBe(0);
  });

  test("returns 0 for unknown units", () => {
    expect(parseSizeToBytes("1XB")).toBe(0);
    expect(parseSizeToBytes("1PB")).toBe(0);
  });
});
