import { z } from "zod/v4";

export interface RegexMatcher {
  readonly regex: string;
  readonly flags?: string;
}

export interface RepeatMatcher {
  readonly repeat: Matcher;
  readonly min: number;
  readonly max: number;
}

export type AlternativeMatcher = readonly Matcher[];

export type Matcher =
  | string
  | AlternativeMatcher
  | RegexMatcher
  | RepeatMatcher;

export type CommandPattern = readonly [
  executable: string,
  ...arguments: Matcher[],
];

export interface HostCommandRule {
  readonly pattern: CommandPattern;
  readonly test_match?: readonly (readonly string[])[];
  readonly test_no_match?: readonly (readonly string[])[];
}

export const RegexMatcherSchema: z.ZodType<RegexMatcher> = z.strictObject({
  regex: z.string(),
  flags: z.string().optional(),
});

export const AlternativeMatcherSchema: z.ZodType<AlternativeMatcher> = z.lazy(
  () => z.array(MatcherSchema).min(1, "Alternatives must not be empty."),
);

export const RepeatMatcherSchema: z.ZodType<RepeatMatcher> = z.lazy(() =>
  z.strictObject({
    repeat: MatcherSchema,
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
);

export const MatcherSchema: z.ZodType<Matcher> = z.lazy(() =>
  z.union([
    z.string(),
    AlternativeMatcherSchema,
    RegexMatcherSchema,
    RepeatMatcherSchema,
  ]),
);

export const CommandPatternSchema: z.ZodType<CommandPattern> = z
  .tuple([z.string().min(1, "Executable must not be empty.")])
  .rest(MatcherSchema);

export const HostCommandRuleSchema: z.ZodType<HostCommandRule> = z.strictObject(
  {
    pattern: CommandPatternSchema,
    test_match: z.array(z.array(z.string())).optional(),
    test_no_match: z.array(z.array(z.string())).optional(),
  },
);
