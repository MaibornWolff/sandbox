import { expect, test } from "bun:test";
import { validateConfiguredEnvironment } from "./environment-arguments.js";

test.each([
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "WAYLAND_SOCKET",
  "SANDBOX_HOST_BRIDGE_TOKEN",
  "SANDBOX_HOST_BRIDGE_CERTIFICATE",
])("reserves session-owned %s", (name) => {
  expect(() => validateConfiguredEnvironment([`${name}=custom`])).toThrow(
    `Environment variable ${name} is reserved for Sandbox`,
  );
});

test("allows unrelated configured environment", () => {
  expect(() =>
    validateConfiguredEnvironment(["EDITOR=vim", "EMPTY="]),
  ).not.toThrow();
});
