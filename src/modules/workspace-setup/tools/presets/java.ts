import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import { installMiseTools } from "../image-setup.js";
import { definePreset } from "../preset-definition.js";

const java = defineCategory({
  id: "java",
  name: "Java",
  section: "languages",
  description: "Java runtime and build tools",
});

export const javaPreset = definePreset(java, [
  {
    id: "java",
    name: "Java",
    description: "Java runtime environment",
    category: java,
    detect: {
      duringUserInit: [hasExecutable("java")],
      duringProjectInit: [],
    },
    imageSetup: { asContainerUser: [installMiseTools(["java@25"])] },
  },
  {
    id: "gradle",
    name: "Gradle",
    description: "Build automation tool",
    category: java,
    detect: {
      duringUserInit: [hasExecutable("gradle")],
      duringProjectInit: [
        hasPath("./build.gradle"),
        hasPath("./build.gradle.kts"),
        hasPath("./gradlew"),
      ],
    },
    imageSetup: { asContainerUser: [installMiseTools(["gradle@latest"])] },
    showWhen: ["java"],
  },
  {
    id: "maven",
    name: "Maven",
    description: "Project management and build tool",
    category: java,
    detect: {
      duringUserInit: [hasExecutable("mvn")],
      duringProjectInit: [hasPath("./pom.xml"), hasPath("./mvnw")],
    },
    imageSetup: { asContainerUser: [installMiseTools(["maven@latest"])] },
    showWhen: ["java"],
  },
]);
