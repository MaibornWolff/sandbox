import { describe, expect, test } from "bun:test";
import { matchesImageReference } from "./image-reference.js";

const id = `sha256:${"a".repeat(64)}`;

describe("image inventory reference matching", () => {
  test.each([
    ["alpine", "docker.io/library/alpine:latest"],
    ["docker.io/alpine", "index.docker.io/library/alpine:latest"],
    ["team/app", "docker.io/team/app:latest"],
    ["localhost:5000/app", "localhost:5000/app:latest"],
    ["registry.example/app:v2", "registry.example/app:v2"],
    [`alpine@${id}`, `docker.io/library/alpine@${id}`],
  ])(
    "resolves equivalent tag or digest references: %s",
    (reference, listed) => {
      expect(
        matchesImageReference(reference, { id, references: [listed] }),
      ).toBe(true);
    },
  );

  test.each([id, id.slice(7), id.slice(0, 19), id.slice(7, 19)])(
    "resolves full and abbreviated image identities: %s",
    (reference) => {
      expect(matchesImageReference(reference, { id, references: [] })).toBe(
        true,
      );
    },
  );

  test.each([
    "alpine:v2",
    "team/alpine",
    "localhost/alpine",
    "alpine*",
    "alp",
    `sha256:${"b".repeat(64)}`,
  ])("does not match a different identity or reference: %s", (reference) => {
    expect(
      matchesImageReference(reference, { id, references: ["alpine:latest"] }),
    ).toBe(false);
  });
});
