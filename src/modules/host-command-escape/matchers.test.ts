import { describe, expect, test } from "bun:test";
import {
  CommandPatternSchema,
  HostCommandRuleSchema,
  MatcherSchema,
} from "./matchers.js";

describe("command matcher schemas", () => {
  test("parses each composable matcher form", () => {
    const matchers = [
      "status",
      { regex: "profile-[0-9]+", flags: "i" },
      ["status", { regex: "show-.+" }],
      { repeat: { regex: ".+" }, min: 0, max: 32 },
    ];

    for (const matcher of matchers) {
      expect(MatcherSchema.parse(matcher)).toEqual(matcher);
    }
  });

  test("parses complete command rules", () => {
    const rule = {
      pattern: ["bun", "test", { repeat: { regex: ".+" }, min: 0, max: 32 }],
      test_match: [["bun", "test"]],
      test_no_match: [["node", "test"]],
    } as const;

    expect(CommandPatternSchema.parse(rule.pattern)).toEqual(rule.pattern);
    expect(HostCommandRuleSchema.parse(rule)).toEqual(rule);
  });

  test("rejects malformed matcher structures", () => {
    expect(MatcherSchema.safeParse({ regex: "x", extra: true }).success).toBe(
      false,
    );
    expect(MatcherSchema.safeParse([]).success).toBe(false);
    expect(CommandPatternSchema.safeParse([]).success).toBe(false);
  });
});
