import { z } from "zod/v4";
import { HostCommandRuleSchema } from "#modules/host-command-escape/index.js";
import { type Config, RUNTIME_IDS, type RuntimeId } from "./config.js";

export type MergeStrategy = "accumulate" | "override";
type DefaultDecision = "runtime" | "value" | "optional";

interface ConfigFieldDefinition<
  ConfigKey extends keyof Config,
  Schema extends z.ZodType,
> {
  readonly configKey: ConfigKey;
  readonly schema: Schema;
  readonly type: string;
  readonly description: string;
  readonly mergeStrategy: MergeStrategy;
  readonly defaultDecision: DefaultDecision;
  readonly defaultValue?: Config[ConfigKey];
  readonly examples: readonly string[];
}

function defineField<ConfigKey extends keyof Config, Schema extends z.ZodType>(
  definition: ConfigFieldDefinition<ConfigKey, Schema>,
): ConfigFieldDefinition<ConfigKey, Schema> {
  return definition;
}

const persistPathInputSchema = z.strictObject({
  path: z.string(),
  default: z.string().optional(),
  global: z.boolean().optional(),
  only_if_exists: z.boolean().optional(),
  use_named_volume: z.string().optional(),
});

const settingsEntryInputSchema = z.union([
  z.string(),
  z.strictObject({
    path: z.string(),
    mode: z.enum(["mount", "copy"]).optional(),
  }),
]);

/**
 * The single machine-readable contract for TOML fields, resolved keys,
 * schema metadata, defaults, merge behavior, and reference examples.
 */
export const CONFIG_FIELD_CATALOG = {
  runtime: defineField({
    configKey: "runtime",
    schema: z.enum(RUNTIME_IDS).optional(),
    type: '"docker" | "podman"',
    description: "Container runtime to use.",
    mergeStrategy: "override",
    defaultDecision: "runtime",
    examples: [],
  }),
  readonly: defineField({
    configKey: "readonly",
    schema: z.boolean().optional(),
    type: "boolean",
    description:
      "Mount the project directory as read-only inside the container.",
    mergeStrategy: "override",
    defaultDecision: "value",
    defaultValue: false,
    examples: [],
  }),
  clipboard: defineField({
    configKey: "clipboard",
    schema: z.enum(["auto", "x11", "disabled"]).optional(),
    type: '"auto" | "x11" | "disabled"',
    description: "Clipboard sharing mode between host and container.",
    mergeStrategy: "override",
    defaultDecision: "value",
    defaultValue: "auto",
    examples: [],
  }),
  full_network: defineField({
    configKey: "fullNetwork",
    schema: z.boolean().optional(),
    type: "boolean",
    description:
      "Disable the network firewall entirely. All outbound traffic is allowed.",
    mergeStrategy: "override",
    defaultDecision: "value",
    defaultValue: false,
    examples: [],
  }),
  no_proxy: defineField({
    configKey: "noProxy",
    schema: z.boolean().optional(),
    type: "boolean",
    description: "Disable the HTTP proxy. Requires full_network = true.",
    mergeStrategy: "override",
    defaultDecision: "value",
    defaultValue: false,
    examples: [],
  }),
  shm_size: defineField({
    configKey: "shmSize",
    schema: z.string().optional(),
    type: "string",
    description:
      'Shared memory size for the container (e.g. for Chromium/Playwright). Example: "2g"',
    mergeStrategy: "override",
    defaultDecision: "optional",
    examples: ['"2g"'],
  }),
  env: defineField({
    configKey: "env",
    schema: z.array(z.string()).optional(),
    type: "string[]",
    description:
      'Environment variables for each shell or command session, not container startup. Format: "VAR" (host passthrough) or "VAR=value" (explicit). Reserved: SANDBOX, SANDBOX_*, CLAUDE_CODE_SSE_PORT, DISPLAY, X11_AVAILABLE.',
    mergeStrategy: "accumulate",
    defaultDecision: "value",
    defaultValue: [],
    examples: ['["ANTHROPIC_API_KEY", "DEBUG=1"]'],
  }),
  mounts: defineField({
    configKey: "mounts",
    schema: z.array(z.string()).optional(),
    type: "string[]",
    description:
      "Additional directories to mount into the container. Format: /path | /path:rw | /src:/dst | ~/path | ./path. Default: read-only if no mode specified.",
    mergeStrategy: "accumulate",
    defaultDecision: "value",
    defaultValue: [],
    examples: ['["~/.aws:ro", "/data/shared:rw"]'],
  }),
  ports: defineField({
    configKey: "ports",
    schema: z.array(z.string()).optional(),
    type: "string[]",
    description:
      "Container ports to expose on the host. Format: port | host:container | interface:host:container.",
    mergeStrategy: "accumulate",
    defaultDecision: "value",
    defaultValue: [],
    examples: ['["3000", "8080:80", "127.0.0.1:9090:9090"]'],
  }),
  allow_network: defineField({
    configKey: "allowNetwork",
    schema: z.array(z.string()).optional(),
    type: "string[]",
    description:
      "Domains allowed through the outbound network firewall. Format: domain | *.domain | domain:port | domain:{port1,port2} | domain:* | domain:{*}. Default ports: 80, 443.",
    mergeStrategy: "accumulate",
    defaultDecision: "value",
    defaultValue: [],
    examples: [
      '["api.example.com", "*.github.com", "db.example.com:5432", "service.example.com:*"]',
    ],
  }),
  allow_host_commands: defineField({
    configKey: "allowHostCommands",
    schema: z.array(HostCommandRuleSchema).optional(),
    type: "array of matcher rules",
    description:
      'Structured argument-vector rules allowed for sandbox escape. Rules can include exact arguments, "?" for one argument, "*" for zero or more arguments, alternatives, regular expressions, repetition of at most 32 arguments, and load-time examples.',
    mergeStrategy: "accumulate",
    defaultDecision: "value",
    defaultValue: [],
    examples: [
      '[[allow_host_commands]]\npattern = ["git", ["status", "diff", "log"]]\ntest_match = [["git", "status"]]\ntest_no_match = [["git", "push"]]',
    ],
  }),
  settings: defineField({
    configKey: "settings",
    schema: z.array(settingsEntryInputSchema).optional(),
    type: 'array of strings or { path, mode = "mount" | "copy" }',
    description:
      'Settings from ~/.config/sandbox/settings/. Strings use mount mode. Tables can select mode = "mount" or "copy". Copy paths must be literal.',
    mergeStrategy: "accumulate",
    defaultDecision: "value",
    defaultValue: [],
    examples: [
      '["~/.claude/settings.json", { path = "~/.codex/config.toml", mode = "copy" }]',
    ],
  }),
  persist_paths: defineField({
    configKey: "persistPaths",
    schema: z.array(persistPathInputSchema).optional(),
    type: "array of objects",
    description:
      "Paths that survive container restarts via host-side storage. Fields: path (required), global (optional), default (optional), only_if_exists (optional).",
    mergeStrategy: "accumulate",
    defaultDecision: "value",
    defaultValue: [],
    examples: [
      '[\n  { path = "~/.claude" },\n  { path = "~/.claude/.credentials.json", global = true, default = "{}" },\n  { path = "./node_modules", only_if_exists = true },\n]',
    ],
  }),
} as const;

export function createCatalogDefaults(runtime: RuntimeId): Config {
  return {
    runtime,
    mounts: [...(CONFIG_FIELD_CATALOG.mounts.defaultValue ?? [])],
    env: [...(CONFIG_FIELD_CATALOG.env.defaultValue ?? [])],
    readonly: CONFIG_FIELD_CATALOG.readonly.defaultValue ?? false,
    persistPaths: [...(CONFIG_FIELD_CATALOG.persist_paths.defaultValue ?? [])],
    clipboard: CONFIG_FIELD_CATALOG.clipboard.defaultValue ?? "auto",
    settings: [...(CONFIG_FIELD_CATALOG.settings.defaultValue ?? [])],
    ports: [...(CONFIG_FIELD_CATALOG.ports.defaultValue ?? [])],
    allowNetwork: [...(CONFIG_FIELD_CATALOG.allow_network.defaultValue ?? [])],
    allowHostCommands: [
      ...(CONFIG_FIELD_CATALOG.allow_host_commands.defaultValue ?? []),
    ],
    fullNetwork: CONFIG_FIELD_CATALOG.full_network.defaultValue ?? false,
    noProxy: CONFIG_FIELD_CATALOG.no_proxy.defaultValue ?? false,
  };
}
