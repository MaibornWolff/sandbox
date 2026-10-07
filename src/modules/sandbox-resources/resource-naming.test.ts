import { expect, test } from "bun:test";
import { getNamedVolumeName, getProjectImageName } from "./resource-naming.js";

test("constructs project image and named volume references", () => {
  expect(getProjectImageName("myproject-ab12")).toBe(
    "sandbox-myproject-ab12:latest",
  );
  expect(getNamedVolumeName("nix")).toBe("sandbox-nix");
});
