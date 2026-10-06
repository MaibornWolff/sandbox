import { describe, expect, test } from "bun:test";
import { createMemoryBackend } from "./__test__/index.js";
import { createNativeClipboardService } from "./service.js";
import type { NativeClipboardBackend } from "./types.js";

function fixture(loadBackend?: () => Promise<NativeClipboardBackend>) {
  const native = createMemoryBackend();
  let loads = 0;
  const service = createNativeClipboardService("linux", () => {
    loads++;
    return loadBackend?.() ?? Promise.resolve(native.backend);
  });
  return {
    native,
    service,
    get loads() {
      return loads;
    },
    [Symbol.asyncDispose]: () => service[Symbol.asyncDispose](),
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("native clipboard service", () => {
  test("loads the backend lazily once and reads fresh snapshots", async () => {
    await using f = fixture();
    expect(f.loads).toBe(0);
    expect(await f.service.discover()).toEqual(["text/plain"]);
    expect((await f.service.read("text/plain")).toString()).toBe(
      "initial text",
    );
    f.native.offer({ formats: ["UTF8_STRING"], text: "new copy" });
    expect((await f.service.read("text/plain")).toString()).toBe("new copy");
    expect(f.loads).toBe(1);
  });

  test("converts image bytes to Base64 for the backend and back", async () => {
    await using f = fixture();
    const image = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
    await f.service.publish({ format: "image/png", data: image });
    expect(f.native.writes).toEqual([image.toString("base64")]);
    expect(await f.service.read("image/png")).toEqual(image);
  });

  test("never reads an image for a file-reference offer", async () => {
    await using f = fixture();
    f.native.offer({ formats: ["text/uri-list"] });
    expect(await f.service.discover()).toEqual([]);
    await expect(f.service.read("image/png")).rejects.toMatchObject({
      code: "missing-format",
    });
    expect(f.native.calls).toEqual(["formats", "formats"]);
  });

  test("maps loader and backend errors without their content", async () => {
    await using unavailable = fixture(async () => {
      throw new Error("secret loader path");
    });
    const loadError = await unavailable.service.discover().catch((e) => e);
    expect(loadError).toMatchObject({ code: "backend-unavailable" });
    expect(String(loadError)).not.toContain("secret");

    await using failing = fixture();
    failing.native.backend.getText = async () => {
      throw new Error("private clipboard contents");
    };
    failing.native.backend.setText = async () => {
      throw new Error("private clipboard contents");
    };
    const readError = await failing.service.read("text/plain").catch((e) => e);
    expect(readError).toMatchObject({ code: "backend-failure" });
    expect(String(readError)).not.toContain("private");
    await expect(
      failing.service.publish({ format: "text/plain", data: Buffer.from("x") }),
    ).rejects.toMatchObject({ code: "publication-uncertain" });
  });

  test("runs one native call at a time in order", async () => {
    await using f = fixture();
    const release = deferred();
    const setText = f.native.backend.setText;
    f.native.backend.setText = async (text) => {
      await release.promise;
      await setText(text);
    };
    const publish = f.service.publish({
      format: "text/plain",
      data: Buffer.from("copied"),
    });
    const read = f.service.read("text/plain");
    await flush();
    expect(f.native.calls).toEqual([]);
    release.resolve();
    await publish;
    expect((await read).toString()).toBe("copied");
    expect(f.native.calls).toEqual(["setText", "formats", "text"]);
  });

  test("bounds waiting calls while a native call hangs", async () => {
    await using f = fixture();
    const release = deferred();
    f.native.backend.availableFormats = async () => {
      await release.promise;
      return ["UTF8_STRING"];
    };
    const calls = Array.from({ length: 8 }, () => f.service.discover());
    await expect(f.service.discover()).rejects.toMatchObject({ code: "busy" });
    release.resolve();
    await Promise.all(calls);
    expect(await f.service.discover()).toEqual(["text/plain"]);
  });

  test("cancels a waiting call without a native call", async () => {
    await using f = fixture();
    const release = deferred();
    f.native.backend.availableFormats = async () => {
      await release.promise;
      return ["UTF8_STRING"];
    };
    const active = f.service.discover();
    const abort = new AbortController();
    const waiting = f.service.read("text/plain", { signal: abort.signal });
    abort.abort(new Error("private abort detail"));
    const error = await waiting.catch((e) => e);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(String(error)).not.toContain("private");
    release.resolve();
    await active;
    await flush();
    expect(f.native.calls).toEqual([]);
  });

  test("reports cancellation after a write started as uncertain", async () => {
    await using f = fixture();
    const started = deferred();
    const release = deferred();
    f.native.backend.setText = async () => {
      started.resolve();
      await release.promise;
    };
    const abort = new AbortController();
    const publish = f.service.publish(
      { format: "text/plain", data: Buffer.from("copy") },
      { signal: abort.signal },
    );
    await started.promise;
    abort.abort();
    await expect(publish).rejects.toMatchObject({
      code: "publication-uncertain",
    });
    release.resolve();
  });

  test("rejects waiting and new calls after disposal", async () => {
    await using f = fixture();
    const release = deferred();
    f.native.backend.availableFormats = async () => {
      await release.promise;
      return ["UTF8_STRING"];
    };
    const active = f.service.discover().catch((e) => e);
    await flush();
    await f.service[Symbol.asyncDispose]();
    expect(await active).toMatchObject({ code: "cancelled" });
    release.resolve();
    await expect(f.service.discover()).rejects.toMatchObject({
      code: "disposed",
    });
  });
});
