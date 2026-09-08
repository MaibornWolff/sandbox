import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import { installMiseTools, runImageSetupCommands } from "../image-setup.js";
import { definePreset } from "../preset-definition.js";
import type { ToolDefinition } from "../tool-definition.js";

const javascript = defineCategory({
  id: "javascript",
  name: "JavaScript",
  section: "languages",
  description: "JavaScript runtimes and package managers",
});

export const nodeTool = {
  id: "node",
  name: "Node.js + npm",
  description: "JavaScript runtime",
  category: javascript,
  aliases: ["nodejs", "npm"],
  defaultForUserInit: true,
  detect: {
    duringUserInit: [hasExecutable("node"), hasPath("~/.nvmrc")],
    duringProjectInit: [hasPath("./package.json")],
  },
  imageSetup: {
    asContainerUser: [
      installMiseTools(["node@lts"]),
      runImageSetupCommands(["corepack enable"]),
    ],
  },
  url: "https://nodejs.org",
} satisfies ToolDefinition<typeof javascript>;

const bunTool = {
  id: "bun",
  name: "Bun",
  description: "Fast JavaScript runtime and package manager",
  category: javascript,
  defaultForUserInit: true,
  detect: {
    duringUserInit: [hasExecutable("bun")],
    duringProjectInit: [hasPath("./bun.lock"), hasPath("./bun.lockb")],
  },
  imageSetup: { asContainerUser: [installMiseTools(["bun@latest"])] },
  url: "https://bun.sh",
} satisfies ToolDefinition<typeof javascript>;

const pnpmTool = {
  id: "pnpm",
  name: "pnpm",
  description: "Fast, disk space efficient package manager",
  category: javascript,
  defaultForUserInit: true,
  detect: {
    duringUserInit: [hasExecutable("pnpm")],
    duringProjectInit: [
      hasPath("./pnpm-lock.yaml"),
      hasPath("./pnpm-workspace.yaml"),
    ],
  },
  imageSetup: {
    asContainerUser: [
      runImageSetupCommands(["corepack install -g pnpm@latest"]),
    ],
  },
  requires: [nodeTool],
  showWhen: ["node"],
  url: "https://pnpm.io",
} satisfies ToolDefinition<typeof javascript>;

export const javascriptPreset = definePreset(javascript, [
  nodeTool,
  bunTool,
  pnpmTool,
]);
