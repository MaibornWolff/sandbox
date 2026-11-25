import { expect, test } from "bun:test";
import type { HookConfig } from "#modules/configuration/index.js";
import { parseBootHooks, runHookEvent, serializeBootHooks } from "./plan.js";

const start = {
  event: "session.start",
  command: ["first"],
  wait: true,
} as const;

test("starts matching hooks in declaration order and applies blocking failure policy", async () => {
  const hooks: readonly HookConfig[] = [
    { ...start, command: ["detached"], wait: false },
    { ...start, command: ["warn"], onError: "warn" },
    { ...start, event: "session.end" },
    { ...start, command: ["fail"] },
    { ...start, command: ["never"] },
  ];
  const launches: string[] = [];
  const warnings: string[] = [];
  await expect(
    runHookEvent({
      hooks,
      event: "session.start",
      warn: (message) => warnings.push(message),
      launch: async (hook) => {
        launches.push(hook.command.join(" "));
        return "timed out";
      },
    }),
  ).rejects.toThrow("Lifecycle hook session.start #3 timed out.");
  expect(launches).toEqual(["detached", "warn", "fail"]);
  expect(warnings).toEqual(["Lifecycle hook session.start #2 timed out."]);
});

test("reports cleanup failures and still launches the remaining hooks", async () => {
  const end = { ...start, event: "session.end" } as const;
  const warnings: string[] = [];
  let launched = 0;
  await runHookEvent({
    hooks: [end, end],
    event: end.event,
    warn: (message) => warnings.push(message),
    launch: async () => {
      if (++launched === 1) throw new Error("transport details");
      return undefined;
    },
  });
  expect(launched).toBe(2);
  expect(warnings).toEqual([
    "Lifecycle hook session.end #1 could not reach the guest launcher.",
  ]);
});

test("freezes only container hooks and rejects invalid private boot plans", () => {
  const containerHook = {
    ...start,
    event: "container.start",
    command: ["./script", "a b", "$(literal)"],
  } as const;
  const serialized = serializeBootHooks(
    [start, containerHook, containerHook],
    "/mounted/project",
  );
  expect(parseBootHooks(serialized)).toEqual({
    projectRoot: "/mounted/project",
    hooks: Array(2).fill({ ...containerHook, onError: "fail" }),
  });
  expect(serializeBootHooks([start], "/mounted/project")).toBeUndefined();
  expect(() =>
    parseBootHooks(
      JSON.stringify({
        version: 2,
        projectRoot: "/mounted/project",
        hooks: [],
      }),
    ),
  ).toThrow("Invalid container lifecycle hook plan");
  expect(() =>
    parseBootHooks(
      JSON.stringify({
        version: 1,
        projectRoot: "/mounted/project",
        hooks: [{ ...start, onError: "fail" }],
      }),
    ),
  ).toThrow("Invalid container lifecycle hook event");
});
