import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import { installMiseTools } from "../image-setup.js";
import { definePreset } from "../preset-definition.js";

const python = defineCategory({
  id: "python",
  name: "Python",
  section: "languages",
  description: "Python runtime and package tools",
});

export const pythonPreset = definePreset(python, [
  {
    id: "python",
    name: "Python",
    description: "Python programming language",
    category: python,
    aliases: ["python3"],
    defaultForUserInit: true,
    detect: {
      duringUserInit: [hasExecutable("python"), hasExecutable("python3")],
      duringProjectInit: [hasPath("./pyproject.toml")],
    },
    imageSetup: { asContainerUser: [installMiseTools(["python@3.13"])] },
    url: "https://www.python.org",
  },
  {
    id: "uv",
    name: "uv",
    description: "Fast Python package installer",
    category: python,
    defaultForUserInit: true,
    detect: {
      duringUserInit: [hasExecutable("uv")],
      duringProjectInit: [hasPath("./uv.lock")],
    },
    imageSetup: { asContainerUser: [installMiseTools(["uv@latest"])] },
    url: "https://github.com/astral-sh/uv",
  },
]);
