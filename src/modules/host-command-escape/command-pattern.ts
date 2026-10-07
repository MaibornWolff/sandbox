import { RE2 } from "re2-wasm";
import { getErrorMessage } from "#shared/errors/index.js";
import type { CommandPattern, HostCommandRule, Matcher } from "./matchers.js";

export const COMMAND_PATTERN_LIMITS = Object.freeze({
  regexLength: 1_024,
  nestingDepth: 8,
  alternatives: 32,
  patternSegments: 64,
  repetition: 32,
  argumentCount: 128,
  argumentLength: 8_192,
});

export interface HostCommandRuleTestFailure {
  readonly field: "test_match" | "test_no_match";
  readonly index: number;
  readonly argv: readonly string[];
  readonly message: string;
}

type CompiledArgumentMatcher =
  | { readonly kind: "any" }
  | { readonly kind: "literal"; readonly value: string }
  | {
      readonly kind: "alternatives";
      readonly alternatives: readonly CompiledArgumentMatcher[];
    }
  | { readonly kind: "regex"; readonly expression: RE2 };

const ANY_ARGUMENT_MATCHER: CompiledArgumentMatcher = Object.freeze({
  kind: "any",
});

type CompiledSegment =
  | CompiledArgumentMatcher
  | {
      readonly kind: "repeat";
      readonly matcher: CompiledArgumentMatcher;
      readonly min: number;
      readonly max: number;
    };

export interface CompiledCommandPattern {
  readonly segments: readonly CompiledSegment[];
}

export class CommandPatternValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandPatternValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new CommandPatternValidationError(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateObjectKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const unsupported = Object.keys(value).find(
    (key) => !allowedKeys.includes(key),
  );
  if (unsupported !== undefined) {
    fail(path, `unsupported property ${JSON.stringify(unsupported)}.`);
  }
}

function compileRegex(
  value: Record<string, unknown>,
  path: string,
): CompiledArgumentMatcher {
  validateObjectKeys(value, ["regex", "flags"], path);
  if (typeof value.regex !== "string") {
    fail(`${path}.regex`, "must be a string.");
  }
  if (value.regex.length > COMMAND_PATTERN_LIMITS.regexLength) {
    fail(
      `${path}.regex`,
      `exceeds the maximum length of ${COMMAND_PATTERN_LIMITS.regexLength}.`,
    );
  }
  const flags = value.flags ?? "";
  if (typeof flags !== "string") fail(`${path}.flags`, "must be a string.");
  if (flags !== "" && flags !== "i") {
    const duplicate = flags.length > new Set(flags).size;
    fail(
      `${path}.flags`,
      duplicate
        ? "contains duplicate flags."
        : 'supports only the stateless flag "i".',
    );
  }

  try {
    return Object.freeze({
      kind: "regex",
      expression: new RE2(`^(?:${value.regex})$`, `${flags}u`),
    });
  } catch (error) {
    const detail = getErrorMessage(error);
    fail(`${path}.regex`, `is not supported by the RE2 engine: ${detail}`);
  }
}

function compileLiteral(value: string, path: string): CompiledArgumentMatcher {
  if (value.length > COMMAND_PATTERN_LIMITS.argumentLength) {
    fail(
      path,
      `exceeds the maximum argument length of ${COMMAND_PATTERN_LIMITS.argumentLength}.`,
    );
  }
  return Object.freeze({ kind: "literal", value });
}

function compileStringArgumentMatcher(
  value: string,
  path: string,
): CompiledArgumentMatcher {
  if (value === "*") {
    fail(path, '"*" is supported only as a top-level pattern segment.');
  }
  if (value === "?") return ANY_ARGUMENT_MATCHER;
  return compileLiteral(value, path);
}

function compileArgumentMatcher(
  value: unknown,
  path: string,
  depth: number,
  ancestors: ReadonlySet<object>,
): CompiledArgumentMatcher {
  if (depth > COMMAND_PATTERN_LIMITS.nestingDepth) {
    fail(
      path,
      `exceeds the maximum nesting depth of ${COMMAND_PATTERN_LIMITS.nestingDepth}.`,
    );
  }
  if (typeof value === "string") {
    return compileStringArgumentMatcher(value, path);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      fail(path, "must not contain a circular matcher.");
    if (value.length === 0) fail(path, "alternative arrays must not be empty.");
    if (value.length > COMMAND_PATTERN_LIMITS.alternatives) {
      fail(
        path,
        `exceeds the maximum of ${COMMAND_PATTERN_LIMITS.alternatives} alternatives.`,
      );
    }
    const nextAncestors = new Set(ancestors).add(value);
    return Object.freeze({
      kind: "alternatives",
      alternatives: Object.freeze(
        value.map((alternative, index) =>
          compileArgumentMatcher(
            alternative,
            `${path}[${index}]`,
            depth + 1,
            nextAncestors,
          ),
        ),
      ),
    });
  }
  if (!isRecord(value)) {
    fail(
      path,
      "must be a literal, alternative array, or regular-expression matcher.",
    );
  }
  if ("repeat" in value) fail(path, "nested repetition is not supported.");
  if (!("regex" in value)) fail(path, 'matcher object must contain "regex".');
  return compileRegex(value, path);
}

function compileRepeat(
  value: Record<string, unknown>,
  path: string,
  ancestors: ReadonlySet<object>,
): CompiledSegment {
  validateObjectKeys(value, ["repeat", "min", "max"], path);
  if (!("min" in value)) fail(`${path}.min`, "is required.");
  if (!("max" in value)) fail(`${path}.max`, "is required.");
  if (!Number.isInteger(value.min) || (value.min as number) < 0) {
    fail(`${path}.min`, "must be a non-negative integer.");
  }
  if (!Number.isInteger(value.max)) fail(`${path}.max`, "must be an integer.");
  const min = value.min as number;
  const max = value.max as number;
  if (max < min) fail(`${path}.max`, "must be greater than or equal to min.");
  if (max > COMMAND_PATTERN_LIMITS.repetition) {
    fail(
      `${path}.max`,
      `exceeds the maximum repetition of ${COMMAND_PATTERN_LIMITS.repetition}.`,
    );
  }
  return Object.freeze({
    kind: "repeat",
    matcher: compileArgumentMatcher(
      value.repeat,
      `${path}.repeat`,
      1,
      ancestors,
    ),
    min,
    max,
  });
}

export function compileCommandPattern(
  pattern: unknown,
): CompiledCommandPattern {
  if (!Array.isArray(pattern)) fail("pattern", "must be an array.");
  if (pattern.length === 0) fail("pattern", "must not be empty.");
  if (pattern.length > COMMAND_PATTERN_LIMITS.patternSegments) {
    fail(
      "pattern",
      `exceeds the maximum of ${COMMAND_PATTERN_LIMITS.patternSegments} segments.`,
    );
  }
  if (typeof pattern[0] !== "string" || pattern[0].length === 0) {
    fail("pattern[0]", "must be a non-empty literal executable.");
  }
  const ancestors = new Set<object>([pattern]);
  const segments = pattern.map((segment, index): CompiledSegment => {
    const path = `pattern[${index}]`;
    if (index === 0) return compileLiteral(segment as string, path);
    if (segment === "*") {
      return Object.freeze({
        kind: "repeat",
        matcher: ANY_ARGUMENT_MATCHER,
        min: 0,
        max: COMMAND_PATTERN_LIMITS.argumentCount,
      });
    }
    if (isRecord(segment) && "repeat" in segment) {
      return compileRepeat(segment, path, ancestors);
    }
    return compileArgumentMatcher(segment, path, 1, ancestors);
  });
  return Object.freeze({
    segments: Object.freeze(segments),
  });
}

export function validateCommandPattern(pattern: unknown): string | null {
  try {
    compileCommandPattern(pattern);
    return null;
  } catch (error) {
    if (error instanceof CommandPatternValidationError) return error.message;
    throw error;
  }
}

export function validateHostCommandRule(
  rule: HostCommandRule,
): readonly HostCommandRuleTestFailure[] {
  const pattern = compileCommandPattern(rule.pattern);
  const failures: HostCommandRuleTestFailure[] = [];
  const fields = ["test_match", "test_no_match"] as const;
  for (const field of fields) {
    const expectedMatch = field === "test_match";
    for (const [index, argv] of (rule[field] ?? []).entries()) {
      if (evaluateCommandPattern(pattern, argv) !== expectedMatch) {
        failures.push({
          field,
          index,
          argv,
          message: expectedMatch
            ? "did not match its rule"
            : "unexpectedly matched its rule",
        });
      }
    }
  }
  return failures;
}

function matchesArgument(
  matcher: CompiledArgumentMatcher,
  argumentIndex: number,
  argv: readonly string[],
  cache: Map<CompiledArgumentMatcher, Map<number, boolean>>,
): boolean {
  const matcherCache = cache.get(matcher) ?? new Map<number, boolean>();
  cache.set(matcher, matcherCache);
  const known = matcherCache.get(argumentIndex);
  if (known !== undefined) return known;
  const argument = argv[argumentIndex];
  const result =
    argument !== undefined &&
    (matcher.kind === "any"
      ? true
      : matcher.kind === "literal"
        ? matcher.value === argument
        : matcher.kind === "regex"
          ? matcher.expression.test(argument)
          : matcher.alternatives.some((alternative) =>
              matchesArgument(alternative, argumentIndex, argv, cache),
            ));
  matcherCache.set(argumentIndex, result);
  return result;
}

interface EvaluationContext {
  readonly argv: readonly string[];
  readonly states: Map<string, boolean>;
  readonly argumentCache: Map<CompiledArgumentMatcher, Map<number, boolean>>;
}

function matchRepetition(
  segment: Extract<CompiledSegment, { readonly kind: "repeat" }>,
  segmentIndex: number,
  argumentIndex: number,
  context: EvaluationContext,
  match: (segmentIndex: number, argumentIndex: number) => boolean,
): boolean {
  let nextArgumentIndex = argumentIndex;
  for (let count = 0; count <= segment.max; count += 1) {
    if (count >= segment.min && match(segmentIndex + 1, nextArgumentIndex)) {
      return true;
    }
    if (
      count === segment.max ||
      !matchesArgument(
        segment.matcher,
        nextArgumentIndex,
        context.argv,
        context.argumentCache,
      )
    ) {
      return false;
    }
    nextArgumentIndex += 1;
  }
  return false;
}

export function evaluateCommandPattern(
  pattern: CompiledCommandPattern,
  argv: readonly string[],
): boolean {
  if (
    argv.length === 0 ||
    argv.length > COMMAND_PATTERN_LIMITS.argumentCount ||
    argv.some(
      (argument) => argument.length > COMMAND_PATTERN_LIMITS.argumentLength,
    )
  ) {
    return false;
  }
  const context: EvaluationContext = {
    argv,
    states: new Map(),
    argumentCache: new Map(),
  };
  const match = (segmentIndex: number, argumentIndex: number): boolean => {
    const key = `${segmentIndex}:${argumentIndex}`;
    const known = context.states.get(key);
    if (known !== undefined) return known;
    const segment = pattern.segments[segmentIndex];
    const result =
      segment === undefined
        ? argumentIndex === argv.length
        : segment.kind === "repeat"
          ? matchRepetition(
              segment,
              segmentIndex,
              argumentIndex,
              context,
              match,
            )
          : matchesArgument(
              segment,
              argumentIndex,
              argv,
              context.argumentCache,
            ) && match(segmentIndex + 1, argumentIndex + 1);
    context.states.set(key, result);
    return result;
  };
  return match(0, 0);
}

function isMatcherArray(matcher: Matcher): matcher is readonly Matcher[] {
  return Array.isArray(matcher);
}

function canonicalMatcher(matcher: Matcher): unknown {
  if (typeof matcher === "string") return matcher;
  if (isMatcherArray(matcher)) return matcher.map(canonicalMatcher);
  if ("repeat" in matcher) {
    return {
      repeat: canonicalMatcher(matcher.repeat),
      min: matcher.min,
      max: matcher.max,
    };
  }
  return matcher.flags === undefined
    ? { regex: matcher.regex }
    : { regex: matcher.regex, flags: matcher.flags };
}

export function formatCommandPattern(pattern: CommandPattern): string {
  return JSON.stringify(pattern.map(canonicalMatcher));
}

export function commandPatternsEqual(
  left: CommandPattern,
  right: CommandPattern,
): boolean {
  return formatCommandPattern(left) === formatCommandPattern(right);
}

export function deduplicateCommandPatterns(
  patterns: readonly CommandPattern[],
): CommandPattern[] {
  const seen = new Set<string>();
  return patterns.filter((pattern) => {
    const canonical = formatCommandPattern(pattern);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}
