export {
  type RunHostCommandEscapeOptions,
  runHostCommandEscape,
} from "./client.js";
export {
  COMMAND_PATTERN_LIMITS,
  CommandPatternValidationError,
  type CompiledCommandPattern,
  commandPatternsEqual,
  compileCommandPattern,
  deduplicateCommandPatterns,
  evaluateCommandPattern,
  formatCommandPattern,
  type HostCommandRuleTestFailure,
  validateCommandPattern,
  validateHostCommandRule,
} from "./command-pattern.js";
export {
  type AlternativeMatcher,
  AlternativeMatcherSchema,
  type CommandPattern,
  CommandPatternSchema,
  type HostCommandRule,
  HostCommandRuleSchema,
  type Matcher,
  MatcherSchema,
  type RegexMatcher,
  RegexMatcherSchema,
  type RepeatMatcher,
  RepeatMatcherSchema,
} from "./matchers.js";
export { HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE } from "./protocol.js";
export {
  type HostCommandEscapeSession,
  type StartHostCommandEscapeSessionOptions,
  startHostCommandEscapeSession,
} from "./session.js";
