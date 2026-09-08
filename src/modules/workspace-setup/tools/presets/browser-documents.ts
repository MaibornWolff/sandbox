import { defineCategory } from "../category-definition.js";
import { hasExecutable } from "../detection.js";
import { installAptPackages, installNpmPackages } from "../image-setup.js";
import { definePreset } from "../preset-definition.js";
import type { ToolDefinition } from "../tool-definition.js";
import { nodeTool } from "./javascript.js";

const browserDocuments = defineCategory({
  id: "browser-documents",
  name: "Browser and documents",
  section: "tools",
  description: "Browser automation and document processing tools",
});

const chromiumTool = {
  id: "chromium",
  name: "Chromium",
  description: "Open-source browser for automation",
  category: browserDocuments,
  detect: {
    duringUserInit: [hasExecutable("chromium")],
    duringProjectInit: [],
  },
  imageSetup: {
    asRoot: [installAptPackages(["chromium", "fonts-liberation"])],
  },
  url: "https://www.chromium.org",
} satisfies ToolDefinition<typeof browserDocuments>;

export const browserDocumentsPreset = definePreset(browserDocuments, [
  chromiumTool,
  {
    id: "libreoffice",
    name: "LibreOffice",
    description: "Open-source office suite for documents and spreadsheets",
    category: browserDocuments,
    detect: {
      duringUserInit: [hasExecutable("libreoffice")],
      duringProjectInit: [],
    },
    imageSetup: { asRoot: [installAptPackages(["libreoffice"])] },
    url: "https://www.libreoffice.org",
  },
  {
    id: "agent-browser",
    name: "Agent Browser",
    description:
      "Browser automation CLI for AI agents with compact text output (requires Chromium)",
    category: browserDocuments,
    detect: {
      duringUserInit: [hasExecutable("agent-browser")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [installNpmPackages(["agent-browser@latest"])],
    },
    requires: [nodeTool, chromiumTool],
    url: "https://github.com/anthropics/agent-browser",
  },
]);
