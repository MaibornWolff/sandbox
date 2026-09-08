import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import {
  addDockerfileLines,
  addShellSetup,
  installMiseTools,
  runImageSetupCommands,
} from "../image-setup.js";
import { definePreset } from "../preset-definition.js";

const platformTools = defineCategory({
  id: "platform-tools",
  name: "Platform tools",
  section: "tools",
  description: "Source control, infrastructure, and project environment tools",
});

export const platformToolsPreset = definePreset(platformTools, [
  {
    id: "gh",
    name: "GitHub CLI",
    description: "GitHub's official CLI",
    category: platformTools,
    detect: {
      duringUserInit: [hasExecutable("gh")],
      duringProjectInit: [],
    },
    imageSetup: { asContainerUser: [installMiseTools(["gh@latest"])] },
    url: "https://cli.github.com",
  },
  {
    id: "glab",
    name: "GitLab CLI",
    description: "GitLab's official CLI",
    category: platformTools,
    detect: {
      duringUserInit: [hasExecutable("glab")],
      duringProjectInit: [],
    },
    imageSetup: { asContainerUser: [installMiseTools(["glab@latest"])] },
    url: "https://gitlab.com/gitlab-org/cli",
  },
  {
    id: "terraform",
    name: "Terraform",
    description: "Infrastructure as code tool",
    category: platformTools,
    detect: {
      duringUserInit: [hasExecutable("terraform")],
      duringProjectInit: [hasPath("./main.tf")],
    },
    imageSetup: {
      asContainerUser: [installMiseTools(["terraform@latest"])],
    },
  },
  {
    id: "kubectl",
    name: "kubectl",
    description: "Kubernetes CLI",
    category: platformTools,
    detect: {
      duringUserInit: [hasExecutable("kubectl")],
      duringProjectInit: [],
    },
    imageSetup: { asContainerUser: [installMiseTools(["kubectl@latest"])] },
  },
  {
    id: "devbox",
    name: "Devbox",
    description: "Nix-powered reproducible dev environments",
    category: platformTools,
    detect: {
      duringUserInit: [hasExecutable("devbox")],
      duringProjectInit: [hasPath("./devbox.json"), hasPath("./devbox.lock")],
    },
    imageSetup: {
      asRoot: [
        runImageSetupCommands(
          [
            "curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install linux --extra-conf 'sandbox = false' --init none --no-confirm",
            "curl -fsSL https://get.jetify.com/devbox | bash -s -- -f",
            "chmod a+r /usr/local/bin/devbox",
            "mkdir -p /home/sandbox/.cache /home/sandbox/.local",
          ],
          {
            chownToContainerUser: [
              "/nix",
              "/home/sandbox/.cache",
              "/home/sandbox/.local",
            ],
          },
        ),
      ],
      asContainerUser: [
        addShellSetup([
          // nix-daemon.sh self-guards and would skip its PATH export on a second load.
          "unset __ETC_PROFILE_NIX_SOURCED",
          "[ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ] && . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh",
          "export NIX_REMOTE=",
          "export DEVBOX_NO_PROMPT=1",
          'eval "$(devbox shellenv --init-hook 2>/dev/null || true)"',
          '[ -f devbox.json ] && eval "$(devbox shellenv 2>/dev/null || true)"',
        ]),
      ],
    },
    allowNetwork: [
      "cache.nixos.org",
      "nixos.org",
      "install.determinate.systems",
      "get.jetify.com",
      // The devbox launcher resolves its version here, and jetify redirects to jetpack.
      "releases.jetify.com",
      "releases.jetpack.io",
      "search.devbox.sh",
    ],
    persistPaths: [{ path: "/nix", use_named_volume: "nix" }],
    projectOnly: true,
    url: "https://www.jetify.com/devbox",
  },
  {
    id: "mise-env",
    name: "Mise Environment",
    description:
      "Auto-install project mise tools (from .mise.toml / mise.toml / .tool-versions)",
    category: platformTools,
    detect: {
      duringUserInit: [],
      duringProjectInit: [
        hasPath("./.mise.toml"),
        hasPath("./mise.toml"),
        hasPath("./.tool-versions"),
        hasPath("./mise.lock"),
      ],
    },
    imageSetup: {
      asRoot: [
        addDockerfileLines(
          [
            "COPY .mise.tom[l] mise.tom[l] .tool-version[s] mise.loc[k] /home/sandbox/project/",
          ],
          {
            chownToContainerUser: [
              "/home/sandbox/project",
              "/home/sandbox/.local",
            ],
          },
        ),
      ],
      asContainerUser: [
        runImageSetupCommands([
          "cd /home/sandbox/project",
          "mise trust --all -y",
          "mise install -y",
          "mise reshim",
        ]),
      ],
    },
    buildContextFiles: [
      { pattern: ".mise.toml", destination: ".mise.toml" },
      { pattern: "mise.toml", destination: "mise.toml" },
      { pattern: ".tool-versions", destination: ".tool-versions" },
      { pattern: "mise.lock", destination: "mise.lock" },
    ],
    projectOnly: true,
    url: "https://mise.jdx.dev",
  },
]);
