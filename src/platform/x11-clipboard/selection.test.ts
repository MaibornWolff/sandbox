import { describe, expect, test } from "bun:test";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { SelectionFixture, settle } from "./__test__/selection-fixture.js";
import { ClipboardSelection, type X11ClipboardOptions } from "./selection.js";

async function setup(overrides: Partial<X11ClipboardOptions> = {}) {
  const fixture = new SelectionFixture();
  const time = createTestClock();
  const errors: Error[] = [];
  const publications: {
    format: string;
    data: Uint8Array;
    generation: number;
  }[] = [];
  const selection = await ClipboardSelection.open(fixture, time.clock, {
    discover: async () => ["text/plain", "image/png"],
    read: async () => Buffer.from("text"),
    publish: async (item) => {
      publications.push(item);
    },
    onError: (error) => {
      errors.push(error);
    },
    ...overrides,
  });
  return {
    fixture,
    time,
    errors,
    publications,
    async [Symbol.asyncDispose]() {
      await selection[Symbol.asyncDispose]();
      await time.dispose();
    },
  };
}

function lastValue(
  fixture: SelectionFixture,
  window = 2000,
): Buffer | undefined {
  return fixture.writes.filter((write) => write.window === window).at(-1)
    ?.property.data;
}

describe("native X11 selection protocol", () => {
  test("discovers metadata and reads current host bytes for each paste", async () => {
    let current = "first";
    let reads = 0;
    await using scope = await setup({
      read: async () => {
        reads++;
        return Buffer.from(current);
      },
    });
    scope.fixture.request("TARGETS");
    await settle();
    expect(reads).toBe(0);
    expect(
      lastValue(scope.fixture)?.includes(
        Buffer.from([scope.fixture.atom("image/png"), 0, 0, 0]),
      ),
    ).toBe(true);
    scope.fixture.request("UTF8_STRING");
    await settle();
    expect(lastValue(scope.fixture)?.toString()).toBe("first");
    current = "second";
    scope.fixture.request("UTF8_STRING");
    await settle();
    expect(lastValue(scope.fixture)?.toString()).toBe("second");
    expect(reads).toBe(2);
    expect(scope.errors).toEqual([]);
  });

  test("uses selection failure for missing targets without stale bytes", async () => {
    await using scope = await setup({
      read: async () => {
        throw new Error("private content must not leak");
      },
    });
    scope.fixture.request("image/png");
    await settle();
    expect(scope.fixture.notifications.at(-1)?.readUInt32LE(20)).toBe(0);
    expect(lastValue(scope.fixture)).toBeUndefined();
    expect(scope.errors.map((error) => error.message)).toEqual([
      "Private X11 clipboard transfer failed",
    ]);
  });

  test("prefers images, publishes once, reclaims current owner and suppresses own events", async () => {
    await using scope = await setup();
    scope.fixture.offer({
      UTF8_STRING: Buffer.from("text"),
      "image/png": Buffer.from("png fixture"),
    });
    await settle();
    expect(scope.publications).toEqual([
      { format: "image/png", data: Buffer.from("png fixture"), generation: 1 },
    ]);
    expect(scope.fixture.owner).toBe(scope.fixture.proxy);
    expect(scope.errors).toEqual([]);
  });

  test("retains source ownership if publication fails", async () => {
    await using scope = await setup({
      publish: async () => {
        throw new Error("publication failed");
      },
    });
    scope.fixture.offer({ UTF8_STRING: Buffer.from("local copy") });
    await settle();
    expect(scope.fixture.owner).toBe(4000);
    expect(scope.errors).toHaveLength(1);
  });

  test("does not reclaim a superseded copy while its write is pending", async () => {
    let finish: () => void = () => undefined;
    let writes = 0;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await using scope = await setup({
      publish: async () => {
        writes++;
        await pending;
      },
    });
    scope.fixture.offer({ UTF8_STRING: Buffer.from("old") });
    await settle();
    scope.fixture.stall = true;
    scope.fixture.offer({ UTF8_STRING: Buffer.from("new") }, 5000);
    finish();
    await settle();
    expect(writes).toBe(1);
    expect(scope.fixture.owner).toBe(5000);
    expect(scope.errors).toEqual([]);
  });

  test("receives incremental copies with property deletion acknowledgements", async () => {
    await using scope = await setup();
    const data = Buffer.alloc(190_001, 97);
    scope.fixture.incremental = true;
    scope.fixture.offer({ "image/png": data });
    await settle();
    await settle();
    expect(scope.publications).toEqual([
      { format: "image/png", data, generation: 1 },
    ]);
    expect(scope.fixture.owner).toBe(scope.fixture.proxy);
    expect(scope.fixture.destroyed).toHaveLength(2);
  });

  test("prepares a complete snapshot before INCR and serves only local chunks", async () => {
    const data = Buffer.alloc(190_001, 67);
    let finish: (value: Uint8Array) => void = () => undefined;
    let reads = 0;
    const pending = new Promise<Uint8Array>((resolve) => {
      finish = resolve;
    });
    await using scope = await setup({
      read: async () => {
        reads++;
        return pending;
      },
    });
    scope.fixture.request("image/png");
    await settle();
    expect(scope.fixture.notifications).toHaveLength(0);
    finish(data);
    await settle();
    expect(scope.fixture.writes.at(-1)?.property.type).toBe(
      scope.fixture.atom("INCR"),
    );
    data.fill(88);
    for (let index = 0; index < 5; index++) {
      scope.fixture.propertyEvent(2000, 3000, 1);
      await settle();
    }
    const chunks = scope.fixture.writes
      .filter(
        (write) =>
          write.window === 2000 &&
          write.property.type !== scope.fixture.atom("INCR"),
      )
      .map((write) => write.property.data);
    expect(chunks.at(-1)?.length).toBe(0);
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(190_001, 67));
    expect(reads).toBe(1);
    expect(scope.time.pendingSleeps()).toBe(0);
  });

  test("cancels transfers when the requestor exits", async () => {
    await using scope = await setup({
      read: async () => Buffer.alloc(100_000),
    });
    scope.fixture.request("image/png");
    await settle();
    const destroyed = Buffer.alloc(32);
    destroyed[0] = 17;
    destroyed.writeUInt32LE(2000, 8);
    scope.fixture.emit(destroyed);
    await settle();
    expect(scope.time.pendingSleeps()).toBe(0);
    expect(scope.errors).toHaveLength(1);
    expect(scope.fixture.notifications).toHaveLength(1);
  });

  test("times out stalled reads and incoming transfers without claiming source", async () => {
    await using scope = await setup({
      read: () => new Promise(() => undefined),
    });
    scope.fixture.request("image/png");
    await settle();
    await scope.time.advanceBy(3_500);
    await settle();
    expect(scope.fixture.notifications.at(-1)?.readUInt32LE(20)).toBe(0);
    scope.fixture.stall = true;
    scope.fixture.offer({ UTF8_STRING: Buffer.from("stalled") });
    await settle();
    await scope.time.advanceBy(10_000);
    await settle();
    expect(scope.fixture.owner).toBe(4000);
    expect(scope.publications).toEqual([]);
    expect(scope.errors).toHaveLength(2);
  });

  test("reclaims an exited source without publishing incomplete data", async () => {
    await using scope = await setup();
    scope.fixture.stall = true;
    scope.fixture.offer({ UTF8_STRING: Buffer.from("lost") });
    scope.fixture.setOwner(0);
    await settle();
    expect(scope.fixture.owner).toBe(scope.fixture.proxy);
    expect(scope.publications).toEqual([]);
    expect(scope.errors).toEqual([]);
  });

  test("rejects requests older than selection ownership", async () => {
    let reads = 0;
    await using scope = await setup({
      read: async () => {
        reads++;
        return Buffer.alloc(0);
      },
    });
    scope.fixture.timestamp = 1;
    scope.fixture.request("UTF8_STRING");
    await settle();
    expect(reads).toBe(0);
    expect(scope.fixture.notifications.at(-1)?.readUInt32LE(20)).toBe(0);
  });

  test("cancels a pending host read when its requestor exits", async () => {
    let readSignal: AbortSignal | undefined;
    await using scope = await setup({
      read: (_format, signal) => {
        readSignal = signal;
        return new Promise(() => undefined);
      },
    });
    scope.fixture.request("image/png");
    await settle();
    const destroyed = Buffer.alloc(32);
    destroyed[0] = 17;
    destroyed.writeUInt32LE(2000, 8);
    scope.fixture.emit(destroyed);
    await settle();
    expect(readSignal?.aborted).toBe(true);
    expect(scope.fixture.notifications).toEqual([]);
    expect(scope.time.pendingSleeps()).toBe(0);
  });

  test("bounds pending requests and cancels all transfers on disposal", async () => {
    const scope = await setup({ read: () => new Promise(() => undefined) });
    await using _scope = scope;
    for (let requestor = 2000; requestor < 2006; requestor++)
      scope.fixture.request("image/png", requestor);
    await settle();
    expect(scope.fixture.notifications).toHaveLength(2);
    await scope[Symbol.asyncDispose]();
    expect(scope.time.pendingSleeps()).toBe(0);
    expect(scope.fixture.listeners.size).toBe(0);
  });
});
