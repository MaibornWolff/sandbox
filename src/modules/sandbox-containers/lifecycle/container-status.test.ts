import { describe, expect, test } from "bun:test";
import { parseSessionDetails } from "./container-status.js";

describe("parseSessionDetails", () => {
  test("parses sessions, empty commands, and embedded pipes", () => {
    expect(
      parseSessionDetails("1234|zsh \n5678|\n999|cat file | grep pattern \n"),
    ).toEqual([
      { pid: "1234", command: "zsh" },
      { pid: "5678", command: "unknown" },
      { pid: "999", command: "cat file | grep pattern" },
    ]);
  });

  test("ignores malformed and empty output", () => {
    expect(parseSessionDetails("malformed\n")).toEqual([]);
    expect(parseSessionDetails("")).toEqual([]);
  });
});
