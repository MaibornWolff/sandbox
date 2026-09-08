import { AsyncLocalStorage } from "node:async_hooks";

const dependencyStore = new AsyncLocalStorage<ReadonlyMap<symbol, unknown>>();
const bindingBrand: unique symbol = Symbol("DependencyBinding");
const bindingValues = new WeakMap<
  DependencyBinding,
  { readonly key: symbol; readonly value: unknown }
>();

/** @lintignore Public opaque dependency binding. */
export interface DependencyBinding {
  readonly [bindingBrand]: true;
}

/** @lintignore Public typed dependency token. */
export interface Dependency<T> {
  provide(value: T): DependencyBinding;
  get(): T;
  getOptional(): T | undefined;
}

export function createDependency<T>(name: string): Dependency<T> {
  const key = Symbol(name);

  return Object.freeze({
    provide(value: T): DependencyBinding {
      const binding: DependencyBinding = Object.freeze({
        [bindingBrand]: true as const,
      });
      bindingValues.set(binding, { key, value });
      return binding;
    },
    get(): T {
      const store = dependencyStore.getStore();
      if (!store?.has(key)) {
        throw new Error(
          `Dependency "${name}" is not registered in the active scope.`,
        );
      }
      return store.get(key) as T;
    },
    getOptional(): T | undefined {
      return dependencyStore.getStore()?.get(key) as T | undefined;
    },
  });
}

export function runWithDependencies<T>(
  bindings: readonly DependencyBinding[],
  callback: () => T,
): T {
  const store = new Map(dependencyStore.getStore());
  for (const binding of bindings) {
    const storedBinding = bindingValues.get(binding);
    if (!storedBinding) {
      throw new Error("Invalid dependency binding.");
    }
    store.set(storedBinding.key, storedBinding.value);
  }
  return dependencyStore.run(store, callback);
}
