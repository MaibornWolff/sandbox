import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import {
  addImagePathEntries,
  installMiseTools,
  runImageSetupCommands,
} from "../image-setup.js";
import { definePreset } from "../preset-definition.js";
import type { ToolDefinition } from "../tool-definition.js";

const dotnet = defineCategory({
  id: "dotnet",
  name: ".NET",
  section: "languages",
  description: ".NET runtime and global tools",
});

const dotnetTool = {
  id: "dotnet",
  name: ".NET",
  description: ".NET runtime",
  category: dotnet,
  detect: {
    duringUserInit: [hasExecutable("dotnet")],
    duringProjectInit: [hasPath("./global.json")],
  },
  imageSetup: { asContainerUser: [installMiseTools(["dotnet@9"])] },
  url: "https://dotnet.microsoft.com",
} satisfies ToolDefinition<typeof dotnet>;

export const dotnetPreset = definePreset(dotnet, [
  dotnetTool,
  {
    id: "dotnet-tools",
    name: ".NET Global Tools",
    description:
      "Common .NET global tools: dotnet-script, dotnet-outdated, dotnet-ef. Note: dotnet format is built into the SDK natively.",
    category: dotnet,
    detect: {
      duringUserInit: [hasExecutable("dotnet-script")],
      duringProjectInit: [hasPath("./.config/dotnet-tools.json")],
    },
    imageSetup: {
      asContainerUser: [
        runImageSetupCommands([
          "dotnet tool install -g dotnet-script",
          "dotnet tool install -g dotnet-outdated-tool",
          "dotnet tool install -g dotnet-ef",
        ]),
        addImagePathEntries({ append: ["/home/sandbox/.dotnet/tools"] }),
      ],
    },
    requires: [dotnetTool],
    showWhen: ["dotnet"],
    allowNetwork: ["api.nuget.org"],
    url: "https://www.nuget.org/packages?q=dotnet-tools",
  },
]);
