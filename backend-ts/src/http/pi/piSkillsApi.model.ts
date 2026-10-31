import type { RunnerConfig } from "../../config/env.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import type { AssistantTool } from "../../pi/tools/toolProviderEnvelope.ts";
import { type SkillMetadata, type SkillRegistryDiagnostic } from "../../skills/registry.ts";

export type SkillRouteContext = { config?: RunnerConfig; database: RunnerDatabase };

export type JsonObject = Record<string, unknown>;

export type SkillRegistryView = {
  disabled?: string[];
  jev?: Record<string, unknown>;
  diagnostics: SkillRegistryDiagnostic[];
  items: SkillMetadata[];
  tools: AssistantTool[];
};
