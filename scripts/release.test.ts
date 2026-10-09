import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  finalizeRelease,
  prepareRelease,
  publishRelease,
  restoreReleaseMetadata,
} from "./release.js";
import { gitCommand, type ReleaseCommand } from "./release-command.js";
import { packRelease, validateReleasePackage } from "./release-package.js";
import {
  readReleasePlan,
  releaseDirectory,
  writeReleasePlan,
} from "./release-plan.js";

async function createRepository() {
  const root = createTestDir("release-");
  const repoRoot = path.join(root, "checkout");
  const remote = path.join(root, "remote.git");
  await mkdir(repoRoot);
  gitCommand(["init", "--bare", remote], root);
  gitCommand(["init", "--initial-branch=main"], repoRoot);
  gitCommand(["config", "core.autocrlf", "false"], repoRoot);
  gitCommand(["config", "user.name", "Release Test"], repoRoot);
  gitCommand(
    ["config", "user.email", "release-test@example.invalid"],
    repoRoot,
  );
  await writeFile(path.join(repoRoot, ".gitignore"), ".release/\n");
  await writeFile(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({ name: "@maibornwolff/sandbox", version: "0.71.0", license: "BSD-3-Clause" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repoRoot, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- First public feature.\n",
  );
  gitCommand(["add", "."], repoRoot);
  gitCommand(["commit", "-m", "feat: prepare public release"], repoRoot);
  gitCommand(["remote", "add", "origin", remote], repoRoot);
  gitCommand(["push", "origin", "main"], repoRoot);
  return {
    root,
    repoRoot,
    remote,
    async [Symbol.asyncDispose]() {
      cleanupTestDir(root);
    },
  };
}

async function prepareCandidate(repoRoot: string) {
  const plan = await prepareRelease({
    repoRoot,
    date: "2026-10-08",
  });
  const tarball = Buffer.from("a validated tarball fixture");
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  await writeFile(
    path.join(releaseDirectory(repoRoot), "package.tgz"),
    tarball,
  );
  await writeReleasePlan(repoRoot, { ...plan, integrity });
  gitCommand(["restore", "--", "package.json", "CHANGELOG.md"], repoRoot);
  return { ...plan, integrity };
}

function createRegistry(integrity: string | null = null) {
  const calls: string[][] = [];
  let published = integrity;
  let publishExitCode = 0;
  const execute: ReleaseCommand = (_command, args) => {
    calls.push([...args]);
    if (args[0] === "view") {
      if (!published)
        return {
          exitCode: 1,
          stdout: JSON.stringify({ error: { code: "E404" } }),
          stderr: "Not found",
        };
      return { exitCode: 0, stdout: JSON.stringify(published), stderr: "" };
    }
    if (args[0] !== "publish")
      throw new Error(`Unexpected npm command ${args[0]}`);
    if (publishExitCode)
      return {
        exitCode: publishExitCode,
        stdout: "",
        stderr: "Publish rejected",
      };
    const tarball = args[1];
    if (!tarball) throw new Error("Missing publish tarball");
    published = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    return { exitCode: 0, stdout: "Published", stderr: "" };
  };
  return {
    execute,
    calls,
    failPublish(code: number) {
      publishExitCode = code;
    },
  };
}

async function advanceMain(repoRoot: string) {
  await writeFile(
    path.join(repoRoot, "new-feature.txt"),
    "Concurrent development\n",
  );
  gitCommand(["add", "new-feature.txt"], repoRoot);
  gitCommand(["commit", "-m", "feat: concurrent change"], repoRoot);
  gitCommand(["push", "origin", "main"], repoRoot);
}

test("validates the saved package without rebuilding it", async () => {
  await using fixture = await createRepository();
  const plan = await prepareRelease({
    repoRoot: fixture.repoRoot,
    date: "2026-10-08",
  });
  await mkdir(path.join(fixture.repoRoot, "bin"));
  await mkdir(path.join(fixture.repoRoot, "dist", "apps", "sandbox"), {
    recursive: true,
  });
  await writeFile(
    path.join(fixture.repoRoot, "bin", "sandbox.js"),
    `console.log(process.argv[2] === "--version" ? "${plan.version}" : "Sandbox help");\n`,
  );
  await writeFile(
    path.join(fixture.repoRoot, "dist", "apps", "sandbox", "main.js"),
    "export {};\n",
  );
  await writeFile(
    path.join(fixture.repoRoot, "SBOM.cdx.json"),
    JSON.stringify({
      metadata: {
        component: { name: plan.packageName, version: plan.version },
      },
    }),
  );
  await writeFile(
    path.join(fixture.repoRoot, "THIRD_PARTY_NOTICES.md"),
    `Version: ${plan.version}\n`,
  );
  await packRelease(fixture.repoRoot);
  const tarballPath = path.join(
    releaseDirectory(fixture.repoRoot),
    "package.tgz",
  );
  const tarball = await readFile(tarballPath);
  await writeFile(
    path.join(fixture.repoRoot, "bin", "sandbox.js"),
    'throw new Error("Source must not be rebuilt");\n',
  );
  await validateReleasePackage(fixture.repoRoot);
  expect(await readFile(tarballPath)).toEqual(tarball);
});

test("package validation rejects a changed tarball before installation", async () => {
  await using fixture = await createRepository();
  await prepareCandidate(fixture.repoRoot);
  await writeFile(
    path.join(releaseDirectory(fixture.repoRoot), "package.tgz"),
    "changed",
  );
  await expect(validateReleasePackage(fixture.repoRoot)).rejects.toThrow(
    "recorded integrity",
  );
});

test("prepares a release candidate without committing or pushing", async () => {
  await using fixture = await createRepository();
  const before = gitCommand(["rev-parse", "HEAD"], fixture.repoRoot);
  gitCommand(["tag", "v0.71.0"], fixture.repoRoot);
  gitCommand(
    ["commit", "--allow-empty", "-m", "fix: correct startup"],
    fixture.repoRoot,
  );
  gitCommand(["push", "origin", "main"], fixture.repoRoot);
  const source = gitCommand(["rev-parse", "HEAD"], fixture.repoRoot);
  const plan = await prepareRelease({
    repoRoot: fixture.repoRoot,
    date: "2026-10-08",
  });
  expect(plan.version).toBe("0.71.1");
  expect(
    JSON.parse(
      await readFile(path.join(fixture.repoRoot, "package.json"), "utf8"),
    ),
  ).toMatchObject({ version: "0.71.1", license: "BSD-3-Clause" });
  expect(
    await readFile(path.join(fixture.repoRoot, "CHANGELOG.md"), "utf8"),
  ).toContain("## [Unreleased]\n\n## [0.71.1] - 2026-10-08");
  expect(source).not.toBe(before);
  expect(gitCommand(["rev-parse", "HEAD"], fixture.repoRoot)).toBe(source);
  expect(
    gitCommand(
      ["--git-dir", fixture.remote, "rev-parse", "main"],
      fixture.root,
    ),
  ).toBe(source);
});

test("rejects a release with no commits after its current version tag", async () => {
  await using fixture = await createRepository();
  gitCommand(["tag", "v0.71.0"], fixture.repoRoot);
  await expect(
    prepareRelease({
      repoRoot: fixture.repoRoot,
      date: "2026-10-08",
    }),
  ).rejects.toThrow("No commits since v0.71.0");
  expect(existsSync(releaseDirectory(fixture.repoRoot))).toBe(false);
  expect(gitCommand(["status", "--porcelain"], fixture.repoRoot)).toBe("");
});

test.each([
  ["fix(cli): correct startup", "0.71.1"],
  ["perf: reduce startup calls", "0.71.1"],
  ["chore: update dependencies", "0.71.1"],
  ["feat(cli): add an option", "0.72.0"],
  ["fix(cli)!: remove an option", "0.72.0"],
  [
    "refactor: change config\n\nBREAKING CHANGE: replace the old config",
    "0.72.0",
  ],
  [
    "refactor: change config\n\nBREAKING-CHANGE: replace the old config",
    "0.72.0",
  ],
])(
  "selects a version from commits since the baseline: %s",
  async (message, version) => {
    await using fixture = await createRepository();
    gitCommand(["tag", "v0.71.0"], fixture.repoRoot);
    gitCommand(["commit", "--allow-empty", "-m", message], fixture.repoRoot);
    const plan = await prepareRelease({
      repoRoot: fixture.repoRoot,
      date: "2026-10-08",
    });
    expect(plan.version).toBe(version);
  },
);

test("selects the highest increment across all unreleased commits", async () => {
  await using fixture = await createRepository();
  gitCommand(["tag", "v0.71.0"], fixture.repoRoot);
  gitCommand(
    ["commit", "--allow-empty", "-m", "feat: add an option"],
    fixture.repoRoot,
  );
  gitCommand(
    ["commit", "--allow-empty", "-m", "fix: correct startup"],
    fixture.repoRoot,
  );
  const plan = await prepareRelease({
    repoRoot: fixture.repoRoot,
    date: "2026-10-08",
  });
  expect(plan.version).toBe("0.72.0");
});

test("rejects a missing baseline tag after earlier releases", async () => {
  await using fixture = await createRepository();
  gitCommand(["tag", "v0.70.0"], fixture.repoRoot);
  await expect(
    prepareRelease({ repoRoot: fixture.repoRoot, date: "2026-10-08" }),
  ).rejects.toThrow("v0.71.0 is missing");
  expect(existsSync(releaseDirectory(fixture.repoRoot))).toBe(false);
});

test("rejects shallow release history", async () => {
  await using fixture = await createRepository();
  gitCommand(
    ["--git-dir", fixture.remote, "symbolic-ref", "HEAD", "refs/heads/main"],
    fixture.root,
  );
  const shallow = path.join(fixture.root, "shallow");
  gitCommand(
    ["clone", "--depth=1", pathToFileURL(fixture.remote).href, shallow],
    fixture.root,
  );
  await expect(
    prepareRelease({ repoRoot: shallow, date: "2026-10-08" }),
  ).rejects.toThrow("full Git history");
  expect(existsSync(releaseDirectory(shallow))).toBe(false);
});

test("rejects tracked local edits before preparation", async () => {
  await using fixture = await createRepository();
  await writeFile(
    path.join(fixture.repoRoot, "CHANGELOG.md"),
    "Local changes\n",
  );
  await expect(
    prepareRelease({
      repoRoot: fixture.repoRoot,
      date: "2026-10-08",
    }),
  ).rejects.toThrow("clean tracked");
});

test("restores the candidate metadata on the exact source commit", async () => {
  await using fixture = await createRepository();
  await prepareCandidate(fixture.repoRoot);
  await restoreReleaseMetadata(fixture.repoRoot);
  expect(
    JSON.parse(
      await readFile(path.join(fixture.repoRoot, "package.json"), "utf8"),
    ).version,
  ).toBe("0.72.0");
});

test("rejects restoring metadata onto a different source commit", async () => {
  await using fixture = await createRepository();
  await prepareCandidate(fixture.repoRoot);
  await advanceMain(fixture.repoRoot);
  await expect(restoreReleaseMetadata(fixture.repoRoot)).rejects.toThrow(
    "source commit",
  );
});

test("publishes the checked tarball without committing release metadata", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  const registry = createRegistry();
  await publishRelease({ repoRoot: fixture.repoRoot, npm: registry.execute });
  expect(registry.calls.filter((args) => args[0] === "publish")).toEqual([
    [
      "publish",
      path.join(releaseDirectory(fixture.repoRoot), "package.tgz"),
      "--access=public",
      "--tag=latest",
      "--registry=https://registry.npmjs.org/",
    ],
  ]);
  expect(gitCommand(["rev-parse", "HEAD"], fixture.repoRoot)).toBe(
    plan.sourceCommit,
  );
  expect(
    JSON.parse(
      await readFile(path.join(fixture.repoRoot, "package.json"), "utf8"),
    ).version,
  ).toBe("0.71.0");
});

test("commits and pushes the version, dated notes, and next Unreleased entry only after publication", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  const registry = createRegistry();
  await publishRelease({ repoRoot: fixture.repoRoot, npm: registry.execute });
  const commit = await finalizeRelease({
    repoRoot: fixture.repoRoot,
    npm: registry.execute,
  });
  expect(
    gitCommand(
      ["--git-dir", fixture.remote, "rev-parse", "main"],
      fixture.root,
    ),
  ).toBe(commit);
  expect(
    gitCommand(
      ["--git-dir", fixture.remote, "rev-parse", "v0.72.0"],
      fixture.root,
    ),
  ).toBe(commit);
  expect(gitCommand(["rev-parse", "HEAD^"], fixture.repoRoot)).toBe(
    plan.sourceCommit,
  );
  expect(
    JSON.parse(
      gitCommand(
        ["--git-dir", fixture.remote, "show", "main:package.json"],
        fixture.root,
      ),
    ).version,
  ).toBe("0.72.0");
  expect(
    gitCommand(
      ["--git-dir", fixture.remote, "show", "main:CHANGELOG.md"],
      fixture.root,
    ),
  ).toContain(
    "## [Unreleased]\n\n## [0.72.0] - 2026-10-08\n\n### Added\n\n- First public feature.",
  );
});

test("does not commit metadata when publication is missing", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  await expect(
    finalizeRelease({
      repoRoot: fixture.repoRoot,
      npm: createRegistry().execute,
    }),
  ).rejects.toThrow("does not match");
  expect(gitCommand(["rev-parse", "HEAD"], fixture.repoRoot)).toBe(
    plan.sourceCommit,
  );
  expect(gitCommand(["status", "--porcelain"], fixture.repoRoot)).toBe("");
});

test("preserves a failed npm publish exit code", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  const registry = createRegistry();
  registry.failPublish(42);
  await expect(
    publishRelease({ repoRoot: fixture.repoRoot, npm: registry.execute }),
  ).rejects.toMatchObject({ exitCode: 42 });
  expect(gitCommand(["rev-parse", "HEAD"], fixture.repoRoot)).toBe(
    plan.sourceCommit,
  );
});

test("recovers an identical publication without publishing twice", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  const registry = createRegistry(plan.integrity);
  await publishRelease({ repoRoot: fixture.repoRoot, npm: registry.execute });
  expect(registry.calls.some((args) => args[0] === "publish")).toBe(false);
});

test("rejects a published version with different contents", async () => {
  await using fixture = await createRepository();
  await prepareCandidate(fixture.repoRoot);
  const registry = createRegistry("sha512-different");
  await expect(
    publishRelease({ repoRoot: fixture.repoRoot, npm: registry.execute }),
  ).rejects.toThrow("does not match");
  expect(registry.calls.some((args) => args[0] === "publish")).toBe(false);
});

test.each([
  JSON.stringify({ error: { code: "E403" } }),
  "",
  "Invalid response",
])(
  "preserves registry errors instead of treating them as an unpublished version: %s",
  async (stdout) => {
    await using fixture = await createRepository();
    await prepareCandidate(fixture.repoRoot);
    const npm: ReleaseCommand = () => ({
      exitCode: 7,
      stdout,
      stderr: "Forbidden",
    });
    await expect(
      publishRelease({ repoRoot: fixture.repoRoot, npm }),
    ).rejects.toMatchObject({ exitCode: 7 });
  },
);

test("does not push a tag when the remote rejects the main commit", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  gitCommand(
    ["--git-dir", fixture.remote, "symbolic-ref", "HEAD", "refs/heads/main"],
    fixture.root,
  );
  gitCommand(
    ["--git-dir", fixture.remote, "config", "core.bare", "false"],
    fixture.root,
  );
  gitCommand(
    [
      "--git-dir",
      fixture.remote,
      "config",
      "receive.denyCurrentBranch",
      "refuse",
    ],
    fixture.root,
  );
  await expect(
    finalizeRelease({
      repoRoot: fixture.repoRoot,
      npm: createRegistry(plan.integrity).execute,
    }),
  ).rejects.toThrow("git failed");
  expect(
    gitCommand(
      ["--git-dir", fixture.remote, "rev-parse", "main"],
      fixture.root,
    ),
  ).toBe(plan.sourceCommit);
  expect(
    gitCommand(["ls-remote", "origin", "refs/tags/v0.72.0"], fixture.repoRoot),
  ).toBe("");
});

test("rejects a modified tarball before registry access", async () => {
  await using fixture = await createRepository();
  await prepareCandidate(fixture.repoRoot);
  await writeFile(
    path.join(releaseDirectory(fixture.repoRoot), "package.tgz"),
    "tampered",
  );
  const registry = createRegistry();
  await expect(
    publishRelease({ repoRoot: fixture.repoRoot, npm: registry.execute }),
  ).rejects.toThrow("integrity");
  expect(registry.calls).toEqual([]);
});

test("rejects modified release metadata", async () => {
  await using fixture = await createRepository();
  await prepareCandidate(fixture.repoRoot);
  await writeFile(
    path.join(releaseDirectory(fixture.repoRoot), "CHANGELOG.md"),
    "tampered",
  );
  await expect(readReleasePlan(fixture.repoRoot)).rejects.toThrow("snapshot");
});

test("stops before publication when main advances", async () => {
  await using fixture = await createRepository();
  await prepareCandidate(fixture.repoRoot);
  await advanceMain(fixture.repoRoot);
  const registry = createRegistry();
  await expect(
    publishRelease({ repoRoot: fixture.repoRoot, npm: registry.execute }),
  ).rejects.toThrow("main changed");
  expect(registry.calls).toEqual([]);
});

test("preserves concurrent work if main advances after npm publication", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  const registry = createRegistry(plan.integrity);
  await advanceMain(fixture.repoRoot);
  const advanced = gitCommand(["rev-parse", "HEAD"], fixture.repoRoot);
  gitCommand(["reset", "--hard", plan.sourceCommit], fixture.repoRoot);
  await expect(
    finalizeRelease({ repoRoot: fixture.repoRoot, npm: registry.execute }),
  ).rejects.toThrow("main changed");
  expect(
    gitCommand(
      ["--git-dir", fixture.remote, "rev-parse", "main"],
      fixture.root,
    ),
  ).toBe(advanced);
  expect(
    gitCommand(["ls-remote", "origin", "refs/tags/v0.72.0"], fixture.repoRoot),
  ).toBe("");
});

test("retries completed finalization without making another commit", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  const registry = createRegistry(plan.integrity);
  const first = await finalizeRelease({
    repoRoot: fixture.repoRoot,
    npm: registry.execute,
  });
  gitCommand(["reset", "--hard", plan.sourceCommit], fixture.repoRoot);
  const retried = await finalizeRelease({
    repoRoot: fixture.repoRoot,
    npm: registry.execute,
  });
  expect(retried).toBe(first);
  expect(
    gitCommand(
      ["--git-dir", fixture.remote, "rev-list", "--count", "main"],
      fixture.root,
    ),
  ).toBe("2");
});

test("rejects a conflicting tag during finalization recovery", async () => {
  await using fixture = await createRepository();
  const plan = await prepareCandidate(fixture.repoRoot);
  gitCommand(
    ["commit", "--allow-empty", "-m", "chore: unrelated tag"],
    fixture.repoRoot,
  );
  gitCommand(["tag", "v0.72.0"], fixture.repoRoot);
  gitCommand(["push", "origin", "v0.72.0"], fixture.repoRoot);
  gitCommand(["reset", "--hard", plan.sourceCommit], fixture.repoRoot);
  await expect(
    finalizeRelease({
      repoRoot: fixture.repoRoot,
      npm: createRegistry(plan.integrity).execute,
    }),
  ).rejects.toThrow("does not match this release");
});

test("rejects an existing conflicting release tag before publishing", async () => {
  await using fixture = await createRepository();
  await prepareCandidate(fixture.repoRoot);
  gitCommand(["tag", "v0.72.0"], fixture.repoRoot);
  gitCommand(["push", "origin", "v0.72.0"], fixture.repoRoot);
  const registry = createRegistry();
  await expect(
    publishRelease({ repoRoot: fixture.repoRoot, npm: registry.execute }),
  ).rejects.toThrow("already exists");
  expect(registry.calls).toEqual([]);
});
