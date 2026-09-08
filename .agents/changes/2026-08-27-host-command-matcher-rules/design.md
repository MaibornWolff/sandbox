---
datetime: 2026-08-27T18:57:51Z
author: Tobias Wagner
tags: [design, security, host-commands, configuration]
---

# Host Command Matcher Rules

## Purpose

Replace broad host-command string patterns with structured argument-vector rules.

A rule describes the complete process argument vector. Each pattern segment is a matcher for one or more arguments. The broker matches the original argument vector and starts the process directly without a shell.

The new format must stay small enough to review in project configuration. It must also express exact arguments, alternatives, regular expressions, and bounded repetition.

## Goals

- Preserve argument boundaries during authorization.
- Make exact rules concise.
- Support alternatives without a regular expression.
- Support regular expressions for variable argument values.
- Compose simple matchers instead of requiring one large regular expression.
- Require an exact executable name.
- Validate examples when configuration loads.
- Keep matching deterministic and bounded.
- Continue to accumulate user and trusted project rules.

## Non-Goals

This design does not add:

- ask or deny decisions
- shell command parsing
- command-specific argument models
- semantic path, URL, or option matchers
- executable regular expressions
- unbounded repetition
- regular expressions over joined command strings
- nested repetition

## Configuration

Define each rule as an `allow_host_commands` array table:

```toml
[[allow_host_commands]]
pattern = ["bun", "run", "test:e2e"]

[[allow_host_commands]]
pattern = ["git", ["status", "diff", "log"]]
```

The first rule permits only `bun run test:e2e`. The second rule permits only `git status`, `git diff`, and `git log`.

A pattern must consume the complete argument vector. `git status --short` does not match the second rule.

The matcher grammar uses mixed-type TOML arrays. For example, a pattern can contain a string, a nested array, and an inline table. Use a TOML 1.0 parser that supports mixed-type arrays. Replace `@iarna/toml`, which rejects this valid TOML 1.0 form. Preserve strict duplicate-key errors and all existing configuration value behavior during the parser change.

### Matcher forms

A pattern is an ordered array of segments. A segment has one of these forms:

```text
Pattern
|-- "literal"                         exact argument
|-- [Matcher, Matcher, ...]           one argument matched by any alternative
|-- { regex = "...", flags = "i" }   one argument matched by a regular expression
`-- { repeat = Matcher, min, max }     bounded sequence of arguments
```

The outer `pattern` array is a sequence. A nested array is an alternative. The different meaning comes from its position.

#### Exact argument

A string matches one complete argument:

```toml
pattern = ["bun", "run", "test:e2e"]
```

Spaces inside a string remain part of one argument:

```toml
pattern = ["tool", "one argument"]
```

#### Alternatives

A nested array matches one argument against any nested matcher:

```toml
pattern = ["git", ["status", "diff", "log"]]
```

Alternatives can combine literals and regular expressions:

```toml
pattern = ["tool", ["default", { regex = 'profile-[0-9]+' }]]
```

Nested alternative arrays are valid. Empty alternative arrays are invalid.

#### Regular expression

A regular-expression matcher matches one complete argument:

```toml
pattern = ["tool", { regex = 'profile-[0-9]+' }]
```

The matcher adds full-value anchoring. The expression above behaves as if it were `^(?:profile-[0-9]+)$`. Users do not add anchors for normal use.

Support only documented, stateless flags. The first version supports case-insensitive matching with `flags = "i"`. Reject duplicate or unsupported flags.

#### Repetition

A repetition matcher applies one matcher to several consecutive arguments:

```toml
pattern = ["tool", { repeat = ["--verbose", "--quiet"], min = 0, max = 2 }]
```

`min` and `max` are required. Apply these constraints:

- `min` must be a non-negative integer.
- `max` must be equal to or greater than `min`.
- `max` must not exceed the implementation limit.
- `repeat` must contain a single-argument matcher.
- `repeat` must not contain another repetition matcher.

Use repetition for the `open` rule so each target can match one of two simple regular expressions:

```toml
[[allow_host_commands]]
pattern = [
  "open",
  { repeat = [{ regex = 'https?://\S+' }, { regex = '[^-].*\.html?', flags = "i" }], min = 1, max = 10 },
]

test_match = [
  ["open", "report.html"],
  ["open", "https://example.com"],
  ["open", "report.html", "https://example.com"],
]

test_no_match = [
  ["open"],
  ["open", "-a", "Terminal"],
  ["open", "Calculator.app"],
  ["open", "file:///Applications/Calculator.app"],
]
```

This rule permits Hypertext Transfer Protocol Secure (HTTPS) and Hypertext Transfer Protocol (HTTP) URLs. It also permits arguments that do not start with `-` and end in `.html` or `.htm`, without regard to letter case. It does not permit application-selection options or application paths.

Allowing arbitrary HTTP and HTTPS URLs can disclose data through a URL. Users must restrict the URL expression when they only trust selected hosts.

TOML 1.0 requires each inline matcher object to remain on one physical line. The surrounding `pattern`, `test_match`, and `test_no_match` arrays can use multiple lines.

## Rule Tests

Use Codex-style examples with explicit test names:

```toml
[[allow_host_commands]]
pattern = ["git", ["status", "diff", "log"]]

test_match = [
  ["git", "status"],
  ["git", "diff"],
  ["git", "log"],
]

test_no_match = [
  ["git", "push"],
  ["git", "status", "--short"],
]
```

Apply these rules:

- `test_match` and `test_no_match` are optional.
- Each example is a complete argument vector.
- Each `test_match` example must match its containing rule.
- Each `test_no_match` example must not match its containing rule.
- Do not parse test examples as shell strings.
- Run rule tests when configuration loads.
- Reject the configuration when a test fails.
- Include the configuration path, rule index, test field, test index, and argument vector in the error.
- Do not send rule tests to the broker.
- Do not include rule tests in the effective runtime policy.

Example failure:

```text
Invalid host command rule in .sandbox/config.toml:
test_no_match[1] unexpectedly matched rule 2:
  ["open", "-a", "Terminal"]
```

Tests document security boundaries near the rule. They do not replace product tests for the matcher implementation.

## Matching Semantics

Use the original argument vector from `sandbox escape -- <command> [arguments...]`.

```text
request argv
  validate non-empty argv
  find rules with the same literal executable
  match each complete argv against each rule
  allow when one complete rule matches
  otherwise reject before process creation
```

Apply these rules:

1. Require a non-empty request argument vector.
2. Require the first pattern segment to be a non-empty literal string.
3. Match the first request argument exactly against that literal.
4. Match later segments from left to right.
5. Match nested alternatives against one argument.
6. Match repetition between `min` and `max` times.
7. Require the rule to consume every request argument.
8. Permit the request when at least one effective rule matches.
9. Reject malformed rules when configuration loads.
10. Reject unmatched requests before process creation.

Use dynamic programming for patterns that contain repetition. Cache each `(pattern segment, argument index)` result. Do not use recursive backtracking without a result cache.

## Regular-Expression Safety

A regular expression matches one argument. It never matches an executable, an argument boundary, or a joined command string.

Use a linear-time regular-expression engine that works on Node.js on macOS, Linux, and Windows. Reject syntax that the selected engine does not support. Do not fall back to the JavaScript backtracking engine for unsupported expressions.

Apply implementation limits to:

- regular-expression source length
- matcher nesting depth
- alternatives per matcher
- pattern segments per rule
- repetition maximum
- request argument count
- request argument length

Compile expressions when configuration loads. Store compiled runtime rules in the host process. Return a configuration error for an invalid expression.

## Configuration Merge

User and trusted project rules form one effective allowlist.

Apply this order:

1. Load and validate user rules.
2. Load and validate trusted project rules.
3. Run each rule's tests against that rule.
4. Append project rules after user rules.
5. Remove structurally equal runtime patterns and keep the first one.
6. Compile the effective patterns for the broker.

Tests do not take part in structural equality. Validate tests before duplicate removal so tests in all configuration layers still run.

A project configuration change continues to use the project trust flow. The broker remains the only authority for runtime authorization.

## List Output

Make `sandbox escape --list` print one canonical pattern per line. Omit tests because they are not runtime permissions.

Use compact JSON for the canonical representation because it preserves argument boundaries and can represent nested matcher objects:

```text
["bun","run","test:e2e"]
["git",["status","diff","log"]]
["open",{"repeat":[{"regex":"https?://\\S+"},{"regex":"[^-].*\\.html?","flags":"i"}],"min":1,"max":10}]
```

Preserve effective rule order. Print no heading. Print no output for an empty allowlist.

## Migration

Replace the string-pattern format. Do not interpret old `*` patterns under the new grammar.

Old configuration:

```toml
allow_host_commands = [
  "open *",
  "bun run test:e2e",
]
```

New configuration:

```toml
[[allow_host_commands]]
pattern = ["open", { repeat = { regex = '.+' }, min = 0, max = 10 }]

[[allow_host_commands]]
pattern = ["bun", "run", "test:e2e"]
```

Reject the old format with an error that shows the new array-table form. Do not silently translate `*` because its broad meaning can hide an unsafe migration.

Update configuration templates, generated configuration reference output, user documentation, cascade documentation, and host-command list examples together.

## Implementation Boundaries

Keep configuration data and operational matchers separate:

```text
configuration
  parse matcher data
  validate rule shape
  run rule examples
  merge rule data

host-command-escape
  compile runtime matchers
  authorize request argv
  format canonical list output
  start allowed process
```

Configuration code returns rule data. It does not construct runtime regular-expression services. The host-command escape component owns compilation and authorization.

Expected areas of change:

```text
package.json and lockfile                   TOML 1.0 parser dependency
src/modules/configuration/                  TOML parser, schema, merge, display, reference
src/modules/host-command-escape/            matcher model, compiler, evaluator, list format
templates/                                  configuration examples
docs/ and README.md                         public syntax and security guidance
tests/e2e/host-command-escape.test.ts       effective behavior through a real session
```

## Test Strategy

Test behavior at the lowest layer that proves it.

### Matcher tests

Cover:

- exact strings
- spaces inside one argument
- literal alternatives
- regular-expression alternatives
- nested alternatives
- case-insensitive expressions
- automatic full-argument matching
- minimum and maximum repetition
- zero-argument repetition
- complete argument-vector consumption
- exact executable enforcement
- malformed and empty matchers
- unsupported flags and expressions
- nesting and size limits
- bounded evaluation for ambiguous alternatives

### Configuration tests

Cover:

- TOML 1.0 mixed-type arrays
- preservation of existing TOML configuration values
- strict duplicate-key rejection
- array-table parsing
- user and project accumulation
- structural duplicate removal
- old-format rejection
- `test_match` success and failure
- `test_no_match` success and failure
- errors with rule and example locations
- tests removed from runtime rules

### Broker and command tests

Cover:

- allowed and rejected argument vectors
- rejection before process creation
- canonical `--list` output
- argument boundaries through the protocol
- `open`-style URL and HTML rules
- option and application rejection

## References

- [Claude Code permissions](https://code.claude.com/docs/en/permissions): command-text wildcard rules and their documented argument-filtering limits
- [Codex rules](https://developers.openai.com/codex/rules): argument-vector patterns and load-time `match` and `not_match` examples
- [Codex execpolicy](https://github.com/openai/codex/tree/main/codex-rs/execpolicy): open source argument-vector policy implementation
- [OpenCode permissions](https://opencode.ai/docs/permissions/): simple wildcard permission rules

## Key Decisions

### Represent rules as argument patterns

- **Decision:** Store each rule as an ordered `pattern` array under `[[allow_host_commands]]`.
- **Reason:** The format mirrors the process argument vector and preserves boundaries.
- **Trade-offs:** Exact rules use more TOML than the old string array.

### Require TOML 1.0 mixed arrays

- **Decision:** Replace the current TOML parser with a TOML 1.0 parser that supports mixed-type arrays.
- **Reason:** A pattern must combine literal strings, nested alternatives, and matcher objects in one array.
- **Trade-offs:** The parser migration affects all configuration loading and needs regression tests for existing values and errors.

### Require an exact executable

- **Decision:** Require the first pattern segment to be a non-empty literal string.
- **Reason:** A regular expression or alternative executable matcher can grant unrelated host programs.
- **Trade-offs:** Cross-platform executable names need separate rules.

### Compose recursive alternatives

- **Decision:** Let a nested array match one argument against any nested literal or regular-expression matcher.
- **Reason:** Users can combine small matchers instead of writing one complex expression.
- **Trade-offs:** The parser must distinguish the outer sequence from nested alternatives by position.

### Keep repetition separate

- **Decision:** Use `{ repeat = Matcher, min, max }` for bounded repetition and prohibit nested repetition.
- **Reason:** Cardinality is independent from value matching. Explicit bounds keep evaluation predictable.
- **Trade-offs:** The inline TOML form can be long.

### Match regular expressions per argument

- **Decision:** Match a regular expression against one complete argument with automatic anchoring.
- **Reason:** This keeps argument boundaries visible and prevents joined-command ambiguity.
- **Trade-offs:** Some policies need several matcher segments or alternatives.

### Use a linear-time regular-expression engine

- **Decision:** Use a portable linear-time engine and reject unsupported expression syntax.
- **Reason:** Trusted configuration must not make broker authorization vulnerable to catastrophic backtracking.
- **Trade-offs:** Users cannot use all JavaScript regular-expression features.

### Add load-time rule tests

- **Decision:** Add optional `test_match` and `test_no_match` argument-vector examples to each rule.
- **Reason:** Examples make complex permissions reviewable and catch policy mistakes before a session starts.
- **Trade-offs:** Large rule sets add configuration text and load-time work.

### Replace old wildcard strings

- **Decision:** Reject the old string format and require explicit migration.
- **Reason:** Silent conversion can preserve an unsafe broad permission.
- **Trade-offs:** Existing configurations require a manual update.

### Keep an allow-only union

- **Decision:** Continue to accumulate user and trusted project rules and allow a request when any rule matches.
- **Reason:** This keeps the current trust and merge model simple.
- **Trade-offs:** A project rule cannot narrow a broad user rule.
