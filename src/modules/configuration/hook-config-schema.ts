import { z } from "zod/v4";
import { HOOK_EVENTS, type HookConfig } from "./config.js";

const timeoutUnits = { ms: 1n, s: 1_000n, m: 60_000n, h: 3_600_000n } as const;
const timeoutUnit = z.enum(["ms", "s", "m", "h"]);

const hookTimeoutSchema = z.string().transform((input, context) => {
  const match = /^(\d+)(?:\.(\d+))?(ms|s|m|h)$/.exec(input);
  const unit = timeoutUnit.safeParse(match?.[3]);
  if (
    input.length <= 64 &&
    match?.[0] === input &&
    match[1] !== undefined &&
    unit.success
  ) {
    const factor = timeoutUnits[unit.data];
    const decimal = match[2] ?? "";
    const divisor = 10n ** BigInt(decimal.length);
    const fraction = (BigInt(decimal) * factor + divisor - 1n) / divisor;
    const milliseconds = BigInt(match[1]) * factor + fraction;
    if (milliseconds > 0n && milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(milliseconds);
    }
  }
  context.addIssue({
    code: "custom",
    message: 'Use a positive duration in ms, s, m, or h, such as "10s".',
  });
  return z.NEVER;
});

export const hookConfigSchema = z
  .strictObject({
    event: z.enum(HOOK_EVENTS),
    command: z
      .array(
        z
          .string()
          .refine(
            (argument) => !argument.includes("\0"),
            "Hook arguments must not contain a NUL character.",
          ),
      )
      .min(1)
      .refine((items) => items[0] !== "", "Hook executable must not be empty."),
    wait: z.boolean().default(false),
    timeout: hookTimeoutSchema.optional(),
    on_error: z.enum(["fail", "warn"]).optional(),
  })
  .transform(
    ({ event, command, wait, timeout, on_error }, context): HookConfig => {
      const start = event === "container.start" || event === "session.start";
      if (!start && on_error !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["on_error"],
          message: "on_error is only allowed on start events.",
        });
        return z.NEVER;
      }
      return {
        event,
        command,
        wait,
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        ...(start ? { onError: on_error ?? "fail" } : {}),
      };
    },
  );
