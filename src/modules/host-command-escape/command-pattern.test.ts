import { describe, expect, test } from "bun:test";
import {
  COMMAND_PATTERN_LIMITS,
  CommandPatternValidationError,
  commandPatternsEqual,
  compileCommandPattern,
  deduplicateCommandPatterns,
  evaluateCommandPattern,
  formatCommandPattern,
  validateCommandPattern,
} from "./command-pattern.js";
import type { CommandPattern } from "./matchers.js";

function matches(pattern: unknown, argv: readonly string[]): boolean {
  return evaluateCommandPattern(compileCommandPattern(pattern), argv);
}

function expectInvalid(pattern: unknown, message: string): void {
  expect(validateCommandPattern(pattern)).toContain(message);
  expect(() => compileCommandPattern(pattern)).toThrow(
    CommandPatternValidationError,
  );
}

describe("command pattern matching", () => {
  test("matches exact complete argument vectors and preserves spaces", () => {
    const pattern = ["bun", "run", "one test"];
    expect(matches(pattern, ["bun", "run", "one test"])).toBe(true);
    expect(matches(pattern, ["bun", "run", "one", "test"])).toBe(false);
    expect(matches(pattern, ["node", "run", "one test"])).toBe(false);
    expect(matches(pattern, ["bun", "run", "one test", "--update"])).toBe(
      false,
    );
  });

  test("matches literal alternatives as exactly one argument", () => {
    const pattern = ["git", ["status", "diff", "log"]];
    for (const subcommand of ["status", "diff", "log"]) {
      expect(matches(pattern, ["git", subcommand])).toBe(true);
    }
    expect(matches(pattern, ["git", "push"])).toBe(false);
    expect(matches(pattern, ["git", "status", "--short"])).toBe(false);
  });

  test("matches nested literal and regular-expression alternatives", () => {
    const pattern = [
      "tool",
      ["default", [[{ regex: "profile-[0-9]+" }], "other"]],
    ];
    expect(matches(pattern, ["tool", "default"])).toBe(true);
    expect(matches(pattern, ["tool", "profile-42"])).toBe(true);
    expect(matches(pattern, ["tool", "other"])).toBe(true);
    expect(matches(pattern, ["tool", "profile-x"])).toBe(false);
  });

  test("anchors regular expressions to one complete argument", () => {
    const pattern = ["tool", { regex: "profile-[0-9]+", flags: "i" }];
    expect(matches(pattern, ["tool", "PROFILE-42"])).toBe(true);
    expect(matches(pattern, ["tool", "xprofile-42"])).toBe(false);
    expect(matches(pattern, ["tool", "profile-42x"])).toBe(false);
    expect(matches(pattern, ["tool", "profile-42", "extra"])).toBe(false);
  });

  test("matches bounded repetition at minimum and maximum", () => {
    const pattern = [
      "open",
      { repeat: ["quiet", { regex: "https?://\\S+" }], min: 1, max: 2 },
    ];
    expect(matches(pattern, ["open"])).toBe(false);
    expect(matches(pattern, ["open", "quiet"])).toBe(true);
    expect(matches(pattern, ["open", "https://example.com", "quiet"])).toBe(
      true,
    );
    expect(matches(pattern, ["open", "quiet", "quiet", "quiet"])).toBe(false);
  });

  test("supports zero repetitions and later pattern segments", () => {
    const pattern = [
      "tool",
      { repeat: ["--verbose", "--quiet"], min: 0, max: 2 },
      "run",
    ];
    expect(matches(pattern, ["tool", "run"])).toBe(true);
    expect(matches(pattern, ["tool", "--quiet", "run"])).toBe(true);
    expect(matches(pattern, ["tool", "--quiet", "--verbose", "run"])).toBe(
      true,
    );
    expect(
      matches(pattern, ["tool", "--quiet", "--quiet", "--quiet", "run"]),
    ).toBe(false);
  });

  test("matches zero or more complete arguments with wildcards", () => {
    const pattern = ["tool", "*", "done"];
    expect(matches(pattern, ["tool", "done"])).toBe(true);
    expect(matches(pattern, ["tool", "one", "two", "done"])).toBe(true);
    expect(matches(pattern, ["tool", "done", "done"])).toBe(true);
    expect(matches(pattern, ["tool", "one", "two"])).toBe(false);

    const splitPattern = ["tool", "*", "--", "*"];
    expect(matches(splitPattern, ["tool", "--"])).toBe(true);
    expect(matches(splitPattern, ["tool", "one", "--", "two", "three"])).toBe(
      true,
    );
    expect(matches(splitPattern, ["tool", "one", "two"])).toBe(false);
  });

  test("matches exactly one complete argument with question wildcards", () => {
    expect(matches(["tool", "?", "done"], ["tool", "value", "done"])).toBe(
      true,
    );
    expect(matches(["tool", "?", "done"], ["tool", "", "done"])).toBe(true);
    expect(matches(["tool", "?", "done"], ["tool", "done"])).toBe(false);
    expect(matches(["tool", "?", "done"], ["tool", "one", "two", "done"])).toBe(
      false,
    );
    expect(matches(["tool", ["safe", "?"]], ["tool", "other"])).toBe(true);
    expect(
      matches(
        ["tool", { repeat: "?", min: 1, max: 2 }],
        ["tool", "one", "two"],
      ),
    ).toBe(true);
  });

  test("reserves only standalone argument wildcard tokens", () => {
    expect(
      matches(["tool", "value*", "value?"], ["tool", "value*", "value?"]),
    ).toBe(true);
    expect(matches(["*", "?"], ["*", "argument"])).toBe(true);
    expect(matches(["*", "?"], ["tool", "argument"])).toBe(false);
  });

  test("matches wildcards up to the request argument limit", () => {
    const maximum = Array.from(
      { length: COMMAND_PATTERN_LIMITS.argumentCount - 1 },
      () => "argument",
    );
    expect(matches(["tool", "*"], ["tool", ...maximum])).toBe(true);
    expect(matches(["tool", "*"], ["tool", ...maximum, "extra"])).toBe(false);
  });

  test("bounds ambiguous alternative evaluation", () => {
    const alternatives = Array.from(
      { length: COMMAND_PATTERN_LIMITS.alternatives },
      () => ["x", ["x"]],
    );
    const pattern = [
      "tool",
      { repeat: alternatives, min: 0, max: COMMAND_PATTERN_LIMITS.repetition },
      "done",
    ];
    const argv = [
      "tool",
      ...Array.from({ length: COMMAND_PATTERN_LIMITS.repetition }, () => "x"),
      "no",
    ];
    expect(matches(pattern, argv)).toBe(false);
  });

  test("rejects request argument count and length limits", () => {
    const repeatPattern = [
      "tool",
      { repeat: "x", min: 0, max: COMMAND_PATTERN_LIMITS.repetition },
    ];
    const tooMany = Array.from(
      { length: COMMAND_PATTERN_LIMITS.argumentCount + 1 },
      () => "x",
    );
    expect(matches(repeatPattern, tooMany)).toBe(false);
    expect(
      matches(
        ["tool", { regex: ".*" }],
        ["tool", "x".repeat(COMMAND_PATTERN_LIMITS.argumentLength + 1)],
      ),
    ).toBe(false);
  });
});

describe("command pattern validation", () => {
  test("requires a non-empty literal executable", () => {
    expectInvalid([], "must not be empty");
    for (const pattern of [[""], [["git"], "status"], [{ regex: "git" }]]) {
      expectInvalid(pattern, "non-empty literal executable");
    }
    expectInvalid("git", "must be an array");
  });

  test("rejects malformed alternatives and matcher objects", () => {
    expectInvalid(["tool", []], "must not be empty");
    expectInvalid(["tool", 42], "must be a literal");
    expectInvalid(["tool", {}], 'must contain "regex"');
    expectInvalid(["tool", { regex: 42 }], "must be a string");
    expectInvalid(
      ["tool", { regex: "x", extra: true }],
      "unsupported property",
    );
  });

  test("rejects unsupported expressions and flags", () => {
    expectInvalid(
      ["tool", { regex: "(?=unsafe)" }],
      "not supported by the RE2 engine",
    );
    expectInvalid(
      ["tool", { regex: "x", flags: "g" }],
      'only the stateless flag "i"',
    );
    expectInvalid(["tool", { regex: "x", flags: "ii" }], "duplicate flags");
    expectInvalid(["tool", { regex: "x", flags: 1 }], "must be a string");
  });

  test("rejects malformed and nested repetition", () => {
    expectInvalid(["tool", { repeat: "x", max: 1 }], "min: is required");
    expectInvalid(["tool", { repeat: "x", min: 0 }], "max: is required");
    expectInvalid(
      ["tool", { repeat: "x", min: -1, max: 1 }],
      "non-negative integer",
    );
    expectInvalid(
      ["tool", { repeat: "x", min: 2, max: 1 }],
      "greater than or equal",
    );
    expectInvalid(
      ["tool", { repeat: "x", min: 0.5, max: 1 }],
      "non-negative integer",
    );
    expectInvalid(
      ["tool", { repeat: { repeat: "x", min: 0, max: 1 }, min: 0, max: 1 }],
      "nested repetition",
    );
    expectInvalid(
      ["tool", [{ repeat: "x", min: 0, max: 1 }]],
      "nested repetition",
    );
  });

  test("rejects sequence wildcards inside single-argument matchers", () => {
    expectInvalid(["tool", ["safe", "*"]], "top-level pattern segment");
    expectInvalid(
      ["tool", { repeat: "*", min: 0, max: 1 }],
      "top-level pattern segment",
    );
  });

  test("enforces all configured pattern limits", () => {
    expectInvalid(
      Array.from(
        { length: COMMAND_PATTERN_LIMITS.patternSegments + 1 },
        () => "x",
      ),
      "maximum of",
    );
    expectInvalid(
      [
        "tool",
        Array.from(
          { length: COMMAND_PATTERN_LIMITS.alternatives + 1 },
          () => "x",
        ),
      ],
      "alternatives",
    );
    expectInvalid(
      ["tool", { regex: "x".repeat(COMMAND_PATTERN_LIMITS.regexLength + 1) }],
      "maximum length",
    );
    expectInvalid(
      ["tool", "x".repeat(COMMAND_PATTERN_LIMITS.argumentLength + 1)],
      "maximum argument length",
    );
    expectInvalid(
      [
        "tool",
        { repeat: "x", min: 0, max: COMMAND_PATTERN_LIMITS.repetition + 1 },
      ],
      "maximum repetition",
    );
    let nested: unknown = "x";
    for (
      let depth = 0;
      depth <= COMMAND_PATTERN_LIMITS.nestingDepth;
      depth += 1
    )
      nested = [nested];
    expectInvalid(["tool", nested], "maximum nesting depth");
  });

  test("rejects circular alternatives", () => {
    const alternative: unknown[] = ["x"];
    alternative.push(alternative);
    expectInvalid(["tool", alternative], "circular matcher");
  });
});

describe("command pattern canonical form", () => {
  test("formats compact JSON with stable matcher property order", () => {
    const first = [
      "open",
      { max: 10, min: 1, repeat: [{ flags: "i", regex: "[^-].*\\.html?" }] },
    ] as CommandPattern;
    const second = [
      "open",
      { repeat: [{ regex: "[^-].*\\.html?", flags: "i" }], min: 1, max: 10 },
    ] as CommandPattern;
    expect(formatCommandPattern(first)).toBe(
      '["open",{"repeat":[{"regex":"[^-].*\\\\.html?","flags":"i"}],"min":1,"max":10}]',
    );
    expect(commandPatternsEqual(first, second)).toBe(true);
    expect(
      deduplicateCommandPatterns([first, second, ["open", "other"]]),
    ).toEqual([first, ["open", "other"]]);
  });
});
