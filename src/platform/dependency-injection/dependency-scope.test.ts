import { describe, expect, test } from "bun:test";
import {
  createDependency,
  type DependencyBinding,
  runWithDependencies,
} from "./dependency-scope.js";

describe("dependency scope", () => {
  test("resolves a dependency within its scope", () => {
    const dependency = createDependency<string>("example dependency");

    const value = runWithDependencies(
      [dependency.provide("scoped value")],
      () => dependency.get(),
    );

    expect(value).toBe("scoped value");
  });

  test("names a missing dependency", () => {
    const dependency = createDependency<string>("runtime provider");

    expect(() => dependency.get()).toThrow(
      'Dependency "runtime provider" is not registered in the active scope.',
    );
  });

  test("optionally resolves compatibility dependencies", () => {
    const dependency = createDependency<string>("legacy adapter");

    expect(dependency.getOptional()).toBeUndefined();
    expect(
      runWithDependencies([dependency.provide("scoped")], () =>
        dependency.getOptional(),
      ),
    ).toBe("scoped");
  });

  test("inherits bindings and restores a replaced binding after sync return", () => {
    const inherited = createDependency<string>("inherited");
    const replaced = createDependency<string>("replaced");

    runWithDependencies(
      [inherited.provide("parent inherited"), replaced.provide("parent")],
      () => {
        expect(
          runWithDependencies([replaced.provide("child")], () => ({
            inherited: inherited.get(),
            replaced: replaced.get(),
          })),
        ).toEqual({ inherited: "parent inherited", replaced: "child" });
        expect(replaced.get()).toBe("parent");
      },
    );
  });

  test("restores a replaced binding after async resolution", async () => {
    const dependency = createDependency<string>("async dependency");

    await runWithDependencies([dependency.provide("parent")], async () => {
      await runWithDependencies([dependency.provide("child")], async () => {
        await Promise.resolve();
        expect(dependency.get()).toBe("child");
      });
      expect(dependency.get()).toBe("parent");
    });
  });

  test("restores a replaced binding after rejection", async () => {
    const dependency = createDependency<string>("rejected dependency");

    await runWithDependencies([dependency.provide("parent")], async () => {
      await expect(
        runWithDependencies([dependency.provide("child")], async () => {
          await Promise.resolve();
          throw new Error("nested failure");
        }),
      ).rejects.toThrow("nested failure");
      expect(dependency.get()).toBe("parent");
    });
  });

  test("isolates overlapping async scopes and their nested replacements", async () => {
    const dependency = createDependency<string>("concurrent dependency");
    let releaseFirst: () => void = () => undefined;
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstIsWaiting: () => void = () => undefined;
    const firstReachedWait = new Promise<void>((resolve) => {
      firstIsWaiting = resolve;
    });

    const first = runWithDependencies(
      [dependency.provide("first")],
      async () => {
        expect(dependency.get()).toBe("first");
        firstIsWaiting();
        await firstMayContinue;
        expect(dependency.get()).toBe("first");
        return runWithDependencies(
          [dependency.provide("first nested")],
          async () => {
            await Promise.resolve();
            return dependency.get();
          },
        );
      },
    );

    const second = runWithDependencies(
      [dependency.provide("second")],
      async () => {
        await firstReachedWait;
        expect(dependency.get()).toBe("second");
        releaseFirst();
        await Promise.resolve();
        return dependency.get();
      },
    );

    expect(await Promise.all([first, second])).toEqual([
      "first nested",
      "second",
    ]);
  });

  test("rejects bindings not created by a dependency token", () => {
    expect(() =>
      runWithDependencies([{} as DependencyBinding], () => undefined),
    ).toThrow("Invalid dependency binding.");
  });

  test("does not leak a rejected concurrent scope", async () => {
    const dependency = createDependency<string>(
      "failing concurrent dependency",
    );

    const rejected = runWithDependencies(
      [dependency.provide("rejected")],
      async () => {
        await Promise.resolve();
        expect(dependency.get()).toBe("rejected");
        throw new Error("expected failure");
      },
    );
    const resolved = runWithDependencies(
      [dependency.provide("resolved")],
      async () => {
        await Promise.resolve();
        return dependency.get();
      },
    );

    await expect(rejected).rejects.toThrow("expected failure");
    expect(await resolved).toBe("resolved");
    expect(() => dependency.get()).toThrow(
      'Dependency "failing concurrent dependency" is not registered in the active scope.',
    );
  });
});
