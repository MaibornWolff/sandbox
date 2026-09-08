import { createToolRegistry } from "./preset-definition.js";
import { PRESET_REGISTRY } from "./presets/index.js";

export const TOOL_REGISTRY = createToolRegistry(PRESET_REGISTRY);
