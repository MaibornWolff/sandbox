import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import { addImagePathEntries, installMiseTools } from "../image-setup.js";
import { definePreset } from "../preset-definition.js";

const rust = defineCategory({
  id: "rust",
  name: "Rust",
  section: "languages",
  description: "Rust language runtime",
});

export const rustPreset = definePreset(rust, [
  {
    id: "rust",
    name: "Rust",
    description: "Rust programming language",
    category: rust,
    detect: {
      duringUserInit: [hasExecutable("rustc"), hasExecutable("cargo")],
      duringProjectInit: [hasPath("./Cargo.toml")],
    },
    imageSetup: {
      asContainerUser: [
        installMiseTools(["rust@stable"]),
        addImagePathEntries({ prepend: ["/home/sandbox/.cargo/bin"] }),
      ],
    },
  },
]);
