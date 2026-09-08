import type { PersistPathInput } from "#modules/configuration/index.js";
import type { CategoryDefinition } from "./category-definition.js";
import type { CapabilityDetectionDeclarations } from "./detection.js";
import type { ImageSetup } from "./image-setup.js";

export interface ToolDefinition<
  Category extends CategoryDefinition = CategoryDefinition,
> {
  id: string;
  name: string;
  description: string;
  category: Category;
  aliases?: readonly string[];
  defaultForUserInit?: boolean;
  detect?: CapabilityDetectionDeclarations;

  imageSetup?: ImageSetup;
  requires?: readonly ToolDefinition[];
  allowNetwork?: string[];
  buildContextFiles?: Array<{
    pattern: string;
    destination: string;
  }>;
  persistPaths?: PersistPathInput[];
  agentConfigId?: string;
  url?: string;
  showWhen?: string[];
  projectOnly?: boolean;
}
