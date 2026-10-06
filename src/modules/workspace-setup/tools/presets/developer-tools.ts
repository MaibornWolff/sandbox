import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import {
  installMiseTools,
  installNpmPackages,
  runImageSetupCommands,
} from "../image-setup.js";
import { definePreset } from "../preset-definition.js";
import { nodeTool } from "./javascript.js";

const developerTools = defineCategory({
  id: "developer-tools",
  name: "Developer tools",
  section: "tools",
  description: "Code navigation, review, editing, and task tools",
});

export const developerToolsPreset = definePreset(developerTools, [
  {
    id: "ast-grep",
    name: "ast-grep",
    description: "Structural code search and rewriting tool",
    category: developerTools,
    detect: {
      duringUserInit: [hasExecutable("ast-grep"), hasExecutable("sg")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [installNpmPackages(["@ast-grep/cli@latest"])],
    },
    requires: [nodeTool],
    url: "https://ast-grep.github.io",
  },
  {
    id: "delta",
    name: "Delta",
    description: "Syntax-highlighting pager for Git, diff, and grep output",
    category: developerTools,
    detect: {
      duringUserInit: [hasExecutable("delta")],
      duringProjectInit: [],
    },
    imageSetup: { asContainerUser: [installMiseTools(["delta@latest"])] },
    url: "https://github.com/dandavison/delta",
  },
  {
    id: "hunk",
    name: "Hunk",
    description:
      "Review-first terminal diff viewer for agent-authored changesets",
    category: developerTools,
    detect: {
      duringUserInit: [hasExecutable("hunk")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [installNpmPackages(["hunkdiff@latest"])],
    },
    requires: [nodeTool],
    url: "https://www.hunk.dev/",
  },
  {
    id: "sem",
    name: "sem",
    description: "Semantic, entity-level diffs for Git repositories",
    category: developerTools,
    detect: {
      duringUserInit: [hasExecutable("sem")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [installNpmPackages(["@ataraxy-labs/sem@latest"])],
    },
    requires: [nodeTool],
    url: "https://github.com/Ataraxy-Labs/sem",
  },
  {
    id: "rtk",
    name: "RTK",
    description:
      "Filters and compresses command output before it reaches the LLM context",
    category: developerTools,
    detect: {
      duringUserInit: [hasExecutable("rtk")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [
        runImageSetupCommands([
          "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
        ]),
      ],
    },
    url: "https://www.rtk-ai.app/",
  },
  {
    id: "neovim",
    name: "Neovim",
    description: "Extensible Vim-based text editor",
    category: developerTools,
    detect: {
      duringUserInit: [hasExecutable("nvim")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [
        runImageSetupCommands([
          "ARCH=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x86_64/') && curl -fLo /tmp/nvim.tar.gz \"https://github.com/neovim/neovim/releases/latest/download/nvim-linux-$" +
            '{ARCH}.tar.gz"',
          "mkdir -p ~/.local",
          "tar -C ~/.local -xzf /tmp/nvim.tar.gz --strip-components=1",
          "rm /tmp/nvim.tar.gz",
        ]),
      ],
    },
    url: "https://neovim.io",
  },
  {
    id: "just",
    name: "just",
    description: "A command runner for project-specific tasks",
    category: developerTools,
    detect: {
      duringUserInit: [hasExecutable("just")],
      duringProjectInit: [hasPath("./justfile")],
    },
    imageSetup: { asContainerUser: [installMiseTools(["just@latest"])] },
    url: "https://just.systems",
  },
]);
