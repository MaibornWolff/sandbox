import { describe, expect, mock, test } from "bun:test";
import {
  expandEnvValue as expandEnvValueWithVariables,
  parseEnvWithExpansion as parseEnvWithVariables,
} from "./env.js";

const HOST_VARIABLES = {
  TEST_HOME: "/home/testuser",
  TEST_PATH: "/usr/bin",
  TEST_EMPTY: "",
  TEST_VAR: "test_value",
  BASE_URL: "https://api.com",
};
const expandEnvValue: typeof expandEnvValueWithVariables = (
  value,
  defined,
  onUndefined,
) => expandEnvValueWithVariables(value, defined, onUndefined, HOST_VARIABLES);
const parseEnvWithExpansion: typeof parseEnvWithVariables = (
  value,
  previous,
  onUndefined,
) => parseEnvWithVariables(value, previous, onUndefined, HOST_VARIABLES);

// Helper to construct strings with braced var syntax without triggering lint warnings
function bracedVar(name: string): string {
  return `\${${name}}`;
}

describe("expandEnvValue - dollar VAR syntax", () => {
  test("expands simple variable", () => {
    const result = expandEnvValue("$TEST_HOME/data", {});
    expect(result).toBe("/home/testuser/data");
  });

  test("expands variable at end of string", () => {
    const result = expandEnvValue("path: $TEST_HOME", {});
    expect(result).toBe("path: /home/testuser");
  });

  test("expands variable alone", () => {
    const result = expandEnvValue("$TEST_HOME", {});
    expect(result).toBe("/home/testuser");
  });

  test("expands variable with underscore", () => {
    const result = expandEnvValue("$TEST_HOME", {});
    expect(result).toBe("/home/testuser");
  });

  test("expands multiple variables", () => {
    const result = expandEnvValue("$TEST_HOME:$TEST_PATH", {});
    expect(result).toBe("/home/testuser:/usr/bin");
  });
});

describe("expandEnvValue - braced syntax", () => {
  test("expands braced variable", () => {
    const result = expandEnvValue(`${bracedVar("TEST_HOME")}/data`, {});
    expect(result).toBe("/home/testuser/data");
  });

  test("allows adjacent text without separator", () => {
    const result = expandEnvValue(`${bracedVar("TEST_HOME")}suffix`, {});
    expect(result).toBe("/home/testusersuffix");
  });

  test("expands braced variable alone", () => {
    const result = expandEnvValue(bracedVar("TEST_HOME"), {});
    expect(result).toBe("/home/testuser");
  });

  test("handles empty braces as literal", () => {
    const input = bracedVar("");
    const result = expandEnvValue(`${input}/data`, {});
    expect(result).toBe(`${bracedVar("")}/data`);
  });

  test("handles unclosed brace as literal", () => {
    const input = "${TEST_HOME/data";
    const result = expandEnvValue(input, {});
    expect(result).toBe("${TEST_HOME/data");
  });
});

describe("expandEnvValue - escape syntax", () => {
  test("escapes $ with backslash", () => {
    const result = expandEnvValue("\\$TEST_HOME", {});
    expect(result).toBe("$TEST_HOME");
  });

  test("escapes $ in middle of string", () => {
    const result = expandEnvValue("cost: \\$100", {});
    expect(result).toBe("cost: $100");
  });

  test("escapes $ before braces", () => {
    const result = expandEnvValue(`\\${bracedVar("TEST_HOME")}`, {});
    expect(result).toBe(bracedVar("TEST_HOME"));
  });

  test("handles multiple escapes", () => {
    const result = expandEnvValue("\\$A \\$B \\$C", {});
    expect(result).toBe("$A $B $C");
  });

  test("mixed escaped and expanded", () => {
    const result = expandEnvValue("\\$literal $TEST_HOME", {});
    expect(result).toBe("$literal /home/testuser");
  });

  test("backslash not followed by $ is preserved", () => {
    const result = expandEnvValue("path\\to\\file", {});
    expect(result).toBe("path\\to\\file");
  });
});

describe("expandEnvValue - undefined variables", () => {
  test("expands undefined to empty string", () => {
    const result = expandEnvValue("$NONEXISTENT_VAR", {});
    expect(result).toBe("");
  });

  test("calls onUndefined callback", () => {
    const onUndefined = mock(() => {});
    expandEnvValue("$NONEXISTENT_VAR", {}, onUndefined);
    expect(onUndefined).toHaveBeenCalledWith("NONEXISTENT_VAR");
  });

  test("calls onUndefined for each undefined variable", () => {
    const undefinedVars: string[] = [];
    expandEnvValue("$UNDEF1/$UNDEF2", {}, (name) => undefinedVars.push(name));
    expect(undefinedVars).toEqual(["UNDEF1", "UNDEF2"]);
  });

  test("expands empty env var correctly (needs braces for adjacent text)", () => {
    // $VAR syntax reads until non-identifier char, so $TEST_EMPTYsuffix is one var name
    // Use braced syntax for adjacent text
    const result = expandEnvValue(`prefix${bracedVar("TEST_EMPTY")}suffix`, {});
    expect(result).toBe("prefixsuffix");
  });
});

describe("expandEnvValue - definedVars precedence", () => {
  test("uses defined variables over the host snapshot", () => {
    const result = expandEnvValue("$TEST_HOME", { TEST_HOME: "/override" });
    expect(result).toBe("/override");
  });

  test("falls back to the host snapshot", () => {
    const result = expandEnvValue("$TEST_HOME", { OTHER: "value" });
    expect(result).toBe("/home/testuser");
  });

  test("combines defined variables with the host snapshot", () => {
    const result = expandEnvValue("$A:$TEST_HOME", { A: "custom" });
    expect(result).toBe("custom:/home/testuser");
  });
});

describe("expandEnvValue - edge cases", () => {
  test("handles empty string", () => {
    const result = expandEnvValue("", {});
    expect(result).toBe("");
  });

  test("handles string without variables", () => {
    const result = expandEnvValue("literal string", {});
    expect(result).toBe("literal string");
  });

  test("handles $ alone", () => {
    const result = expandEnvValue("$", {});
    expect(result).toBe("$");
  });

  test("handles $ at end of string", () => {
    const result = expandEnvValue("end$", {});
    expect(result).toBe("end$");
  });

  test("handles $$ (not double expansion)", () => {
    const result = expandEnvValue("$$TEST_HOME", {});
    // First $ is not a valid var ref (no name), so literal $
    // Second $TEST_HOME expands
    expect(result).toBe("$/home/testuser");
  });

  test("handles $ followed by digit", () => {
    const result = expandEnvValue("$1abc", {});
    // $1 is not valid (starts with digit), so literal
    expect(result).toBe("$1abc");
  });

  test("handles $ followed by space", () => {
    const result = expandEnvValue("$ TEST", {});
    expect(result).toBe("$ TEST");
  });

  test("handles trailing backslash", () => {
    const result = expandEnvValue("path\\", {});
    expect(result).toBe("path\\");
  });

  test("handles braced var with invalid chars", () => {
    // bracedVar creates ${...} which biome thinks is a template placeholder
    // Using a helper to avoid the lint warning
    const invalidBracedVar = "$" + "{VAR-NAME}";
    const result = expandEnvValue(invalidBracedVar, {});
    // Invalid char in braces - not a valid reference
    expect(result).toBe(invalidBracedVar);
  });
});

describe("parseEnvWithExpansion - passthrough", () => {
  test("passes through a variable from the host snapshot", () => {
    const result = parseEnvWithExpansion("TEST_VAR", []);
    expect(result).toBe("TEST_VAR=test_value");
  });

  test("returns undefined for unset passthrough var", () => {
    const result = parseEnvWithExpansion("UNSET_VAR", []);
    expect(result).toBeUndefined();
  });
});

describe("parseEnvWithExpansion - explicit assignment", () => {
  test("expands a variable from the host snapshot", () => {
    const result = parseEnvWithExpansion("API_URL=$BASE_URL/v1", []);
    expect(result).toBe("API_URL=https://api.com/v1");
  });

  test("expands variable from previous envs", () => {
    const result = parseEnvWithExpansion("FULL=$BASE/api", [
      "BASE=http://localhost",
    ]);
    expect(result).toBe("FULL=http://localhost/api");
  });

  test("previous values take precedence over the host snapshot", () => {
    const result = parseEnvWithExpansion("URL=$BASE_URL", [
      "BASE_URL=http://override",
    ]);
    expect(result).toBe("URL=http://override");
  });

  test("handles literal value without expansion", () => {
    const result = parseEnvWithExpansion("KEY=literal", []);
    expect(result).toBe("KEY=literal");
  });

  test("handles empty value", () => {
    const result = parseEnvWithExpansion("EMPTY=", []);
    expect(result).toBe("EMPTY=");
  });

  test("handles value with equals sign", () => {
    const result = parseEnvWithExpansion("QUERY=a=1&b=2", []);
    expect(result).toBe("QUERY=a=1&b=2");
  });
});

describe("parseEnvWithExpansion - warnings and escaping", () => {
  test("calls onUndefined for undefined variables", () => {
    const warnings: Array<{ varName: string; fullEnv: string }> = [];
    parseEnvWithExpansion("FOO=$UNDEFINED", [], (varName, fullEnv) => {
      warnings.push({ varName, fullEnv });
    });
    expect(warnings).toEqual([
      { varName: "UNDEFINED", fullEnv: "FOO=$UNDEFINED" },
    ]);
  });

  test("expands undefined to empty and warns", () => {
    const warnings: string[] = [];
    const result = parseEnvWithExpansion("FOO=$UNDEFINED", [], (varName) => {
      warnings.push(varName);
    });
    expect(result).toBe("FOO=");
    expect(warnings).toEqual(["UNDEFINED"]);
  });

  test("preserves escaped dollar sign", () => {
    const result = parseEnvWithExpansion("PRICE=\\$100", []);
    expect(result).toBe("PRICE=$100");
  });

  test("mixed escaped and expanded", () => {
    const result = parseEnvWithExpansion("MSG=\\$literal $TEST_VAR", []);
    expect(result).toBe("MSG=$literal test_value");
  });
});

describe("parseEnvWithExpansion - multiple previous envs", () => {
  test("can reference earlier defined vars", () => {
    const previousEnvs = ["A=first", "B=second"];
    const result = parseEnvWithExpansion("C=$A-$B", previousEnvs);
    expect(result).toBe("C=first-second");
  });

  test("later definitions in previousEnvs override earlier", () => {
    const previousEnvs = ["VAR=first", "VAR=second"];
    const result = parseEnvWithExpansion("OUT=$VAR", previousEnvs);
    expect(result).toBe("OUT=second");
  });
});
