import { aiAgentsPreset } from "./ai-agents.js";
import { browserDocumentsPreset } from "./browser-documents.js";
import { developerToolsPreset } from "./developer-tools.js";
import { dotnetPreset } from "./dotnet.js";
import { goPreset } from "./go.js";
import { javaPreset } from "./java.js";
import { javascriptPreset } from "./javascript.js";
import { phpPreset } from "./php.js";
import { platformToolsPreset } from "./platform-tools.js";
import { pythonPreset } from "./python.js";
import { rustPreset } from "./rust.js";

export const PRESET_REGISTRY = [
  javascriptPreset,
  pythonPreset,
  javaPreset,
  goPreset,
  rustPreset,
  dotnetPreset,
  phpPreset,
  developerToolsPreset,
  platformToolsPreset,
  browserDocumentsPreset,
  aiAgentsPreset,
] as const;
