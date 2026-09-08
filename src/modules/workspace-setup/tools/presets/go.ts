import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import { addImagePathEntries, installMiseTools } from "../image-setup.js";
import { definePreset } from "../preset-definition.js";
import type { ToolDefinition } from "../tool-definition.js";

const go = defineCategory({
  id: "go",
  name: "Go",
  section: "languages",
  description: "Go language runtime",
});

const goTool = {
  id: "go",
  name: "Go",
  description: "Go programming language",
  category: go,
  detect: {
    duringUserInit: [hasExecutable("go")],
    duringProjectInit: [hasPath("./go.mod"), hasPath("./go.work")],
  },
  imageSetup: {
    asContainerUser: [
      installMiseTools(["go@latest"]),
      addImagePathEntries({ prepend: ["/home/sandbox/go/bin"] }),
    ],
  },
} satisfies ToolDefinition<typeof go>;

export const goPreset = definePreset(go, [goTool]);
