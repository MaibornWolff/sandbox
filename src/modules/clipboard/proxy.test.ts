import { expect, test } from "bun:test";
import { createHostBridgeService } from "#modules/host-bridge/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createFakeNativeClipboardService } from "#platform/native-clipboard/__test__/index.js";
import {
  createNodeWebSocketService,
  provideWebSocketService,
} from "#platform/websocket/index.js";
import type { X11ClipboardService } from "#platform/x11-clipboard/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { createClipboardCapabilityFactory } from "./host-capability.js";
import {
  createClipboardProxyRunner,
  decodeClipboardProxyReady,
} from "./proxy.js";

type X11ClipboardOptions = Parameters<X11ClipboardService["openSession"]>[0];

test("proxy verifies grants before display readiness and routes each selection request to current content", () =>
  runWithTestLogger(async () => {
    const webSockets = createNodeWebSocketService();
    return runWithDependencies(
      [provideWebSocketService(webSockets)],
      async () => {
        await using native = createFakeNativeClipboardService({
          format: "text/plain",
          data: Buffer.from("first"),
        });
        await using capabilities =
          createClipboardCapabilityFactory(native).create();
        await using bridge = await createHostBridgeService(
          webSockets,
        ).startSession({
          containerHostName: "127.0.0.1",
          capabilities: capabilities.capabilities,
        });
        const ready = Promise.withResolvers<string>();
        const ended = Promise.withResolvers<void>();
        const controller = new AbortController();
        let providers: X11ClipboardOptions | undefined;
        let disposed = false;
        const runner = createClipboardProxyRunner({
          async openSession(options) {
            providers = options;
            options.signal?.addEventListener("abort", () => ended.resolve(), {
              once: true,
            });
            return {
              environment: { DISPLAY: ":100", XAUTHORITY: "/tmp/private/auth" },
              completion: ended.promise,
              async [Symbol.asyncDispose]() {
                disposed = true;
              },
            };
          },
        });
        const running = runner.run({
          environment: bridge.clientEnvironment,
          signal: controller.signal,
          onControl: ready.resolve,
        });
        await using _stop = {
          async [Symbol.asyncDispose]() {
            controller.abort();
            ended.resolve();
            await running;
          },
        };
        const environment = decodeClipboardProxyReady(await ready.promise);
        expect(environment).toEqual({
          DISPLAY: ":100",
          XAUTHORITY: "/tmp/private/auth",
          WAYLAND_DISPLAY: "",
        });
        if (!providers) throw new Error("Display did not receive providers.");
        expect(await providers.discover(controller.signal)).toEqual([
          "text/plain",
        ]);
        expect(
          Buffer.from(
            await providers.read("text/plain", controller.signal),
          ).toString(),
        ).toBe("first");
        native.replace({ format: "text/plain", data: Buffer.from("new") });
        expect(
          Buffer.from(
            await providers.read("text/plain", controller.signal),
          ).toString(),
        ).toBe("new");
        await providers.publish(
          { format: "text/plain", data: Buffer.from("copy"), generation: 1 },
          controller.signal,
        );
        expect(native.publications).toHaveLength(1);
        controller.abort();
        await running;
        expect(disposed).toBe(true);
      },
    );
  }));
