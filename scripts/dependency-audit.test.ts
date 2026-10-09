import { expect, test } from "bun:test";
import { evaluateDependencyAudit } from "./dependency-audit.js";

function report(
  severity: string,
  options: { readonly title?: string; readonly cwe?: readonly string[] } = {},
): string {
  return JSON.stringify({
    dependency: [
      {
        title: options.title ?? "Advisory",
        url: "https://github.com/advisories/example",
        severity,
        ...(options.cwe ? { cwe: options.cwe } : {}),
      },
    ],
  });
}

test.each(["low", "moderate", "high"])(
  "reports %s vulnerabilities without blocking",
  (severity) => {
    const audit = evaluateDependencyAudit(report(severity), 1);
    expect(audit.blocked).toBe(false);
    expect(audit.findings).toEqual([
      {
        name: "dependency",
        title: "Advisory",
        url: "https://github.com/advisories/example",
        severity,
      },
    ]);
  },
);

test("critical vulnerabilities block", () => {
  expect(evaluateDependencyAudit(report("critical"), 1).blocked).toBe(true);
});

test.each([
  { title: "stack exhaustion", cwe: ["CWE-674"] },
  { title: "denial-of-service vulnerability" },
])("denial-of-service advisories are ignored: %j", (options) => {
  expect(evaluateDependencyAudit(report("critical", options), 1)).toEqual({
    findings: [],
    blocked: false,
  });
});

test("mixed-impact advisories are not ignored", () => {
  const audit = evaluateDependencyAudit(
    report("critical", { cwe: ["CWE-674", "CWE-79"] }),
    1,
  );
  expect(audit.blocked).toBe(true);
});

test("clean audit passes", () => {
  expect(evaluateDependencyAudit("{}", 0)).toEqual({
    findings: [],
    blocked: false,
  });
});

test("scanner failure does not pass as a clean audit", () => {
  expect(() => evaluateDependencyAudit("{}", 1)).toThrow(
    "without a vulnerability report",
  );
});

test("registry error does not pass as a vulnerability report", () => {
  expect(() =>
    evaluateDependencyAudit('{"error":"registry unavailable"}', 1),
  ).toThrow();
});

test("invalid response blocks", () => {
  expect(() => evaluateDependencyAudit("Service unavailable", 1)).toThrow();
});

test("unexpected severity blocks instead of being ignored", () => {
  expect(() => evaluateDependencyAudit(report("unknown"), 1)).toThrow();
});

test("unexpected scanner exit code blocks", () => {
  expect(() => evaluateDependencyAudit("{}", 2)).toThrow("exit code 2");
});
