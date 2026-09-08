import { describe, expect, test } from "bun:test";
import { getContainerBaseName } from "./container-naming.js";

describe("getContainerBaseName", () => {
  test("returns the project container base name", () => {
    expect(getContainerBaseName("myproject-ab12")).toBe(
      "sandbox-myproject-ab12",
    );
  });
});
