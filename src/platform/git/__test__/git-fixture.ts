import { resolve } from "node:path";
import type { ProcessTestHarness } from "#platform/process/__test__/index.js";

export interface GitRepositoryState {
  readonly root: string;
  readonly queriedPath?: string;
  readonly worktreeRoot?: string;
  readonly remoteUrl?: string;
  readonly ignoredPaths?: readonly string[];
}

export interface GitFixture {
  prepare(): void;
  givenRepository(repository: GitRepositoryState): void;
  givenNoRepository(projectPath: string): void;
  givenFailure(options: {
    readonly projectPath: string;
    readonly operation:
      | "roots"
      | "common-root"
      | "worktree-root"
      | "remote"
      | "ignored";
    readonly path?: string;
    readonly exitCode?: number;
    readonly stderr?: string;
  }): void;
  operations(): readonly {
    readonly args: readonly string[];
    readonly projectPath: string | null;
  }[];
}

const success = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
const failure = (exitCode = 128, stderr = "fatal: not a git repository") => ({
  exitCode,
  stdout: "",
  stderr,
});

function commandFor(options: {
  readonly projectPath: string;
  readonly operation:
    | "roots"
    | "common-root"
    | "worktree-root"
    | "remote"
    | "ignored";
  readonly path?: string;
}): readonly string[] {
  const prefix = ["-C", resolve(options.projectPath)];
  switch (options.operation) {
    case "roots":
      return [
        ...prefix,
        "rev-parse",
        "--show-toplevel",
        "--path-format=absolute",
        "--git-common-dir",
      ];
    case "common-root":
      return [
        ...prefix,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ];
    case "worktree-root":
      return [...prefix, "rev-parse", "--show-toplevel"];
    case "remote":
      return [...prefix, "remote", "get-url", "origin"];
    case "ignored":
      return [...prefix, "check-ignore", "--quiet", options.path ?? ""];
  }
}

export function createGitFixture(processes: ProcessTestHarness): GitFixture {
  const results = new Map<string, ReturnType<typeof success>>();

  function givenResult(
    args: readonly string[],
    result: ReturnType<typeof success>,
  ): void {
    results.set(JSON.stringify(args), result);
  }

  return {
    prepare() {
      for (const [serializedArgs, result] of results) {
        const args = JSON.parse(serializedArgs) as string[];
        processes
          .expectStart({ match: { command: "git", args } })
          .resolveResult(result);
      }
    },
    givenRepository(repository) {
      const queriedPath =
        repository.queriedPath ?? repository.worktreeRoot ?? repository.root;
      const worktreeRoot = repository.worktreeRoot ?? repository.root;
      givenResult(
        commandFor({ projectPath: queriedPath, operation: "roots" }),
        success(
          `${resolve(worktreeRoot)}\n${resolve(repository.root, ".git")}\n`,
        ),
      );
      givenResult(
        commandFor({ projectPath: queriedPath, operation: "common-root" }),
        success(`${resolve(repository.root, ".git")}\n`),
      );
      givenResult(
        commandFor({ projectPath: queriedPath, operation: "worktree-root" }),
        success(`${resolve(worktreeRoot)}\n`),
      );
      if (repository.remoteUrl !== undefined) {
        givenResult(
          commandFor({ projectPath: queriedPath, operation: "remote" }),
          success(`${repository.remoteUrl}\n`),
        );
      }
      for (const ignoredPath of repository.ignoredPaths ?? []) {
        givenResult(
          commandFor({
            projectPath: queriedPath,
            operation: "ignored",
            path: ignoredPath,
          }),
          success(""),
        );
      }
    },
    givenNoRepository(projectPath) {
      givenResult(commandFor({ projectPath, operation: "roots" }), failure());
      givenResult(
        commandFor({ projectPath, operation: "common-root" }),
        failure(),
      );
      givenResult(
        commandFor({ projectPath, operation: "worktree-root" }),
        failure(),
      );
    },
    givenFailure(options) {
      givenResult(
        commandFor(options),
        failure(options.exitCode, options.stderr),
      );
    },
    operations() {
      return processes.requests
        .filter((request) => request.command === "git")
        .map((request) => ({
          args: [...(request.args ?? [])],
          projectPath:
            request.args?.[0] === "-C" ? (request.args[1] ?? null) : null,
        }));
    },
  };
}
