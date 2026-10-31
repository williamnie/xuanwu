import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type RunnerDatabase } from "../../db/database.ts";
import type { ContextBundleTrigger } from "../../db/repositories/contextBundles.ts";
import { createContextBundle, type ContextBundleRecord } from "../../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { getIntakeRun, listAttentionInboxItems, listIntakeRuns } from "../../db/repositories/intakeRuns.ts";
import { createPiMemoryItem } from "../../db/repositories/pi.ts";
import { readSkillRegistry } from "../../skills/registry.ts";
import { runIntakeSkill, runLlmIntake, type LlmIntakeRequest } from "./llmIntake.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, FIXTURE_SKILLS, type ChatBundleFixture, item, ignoredModel, createChatBundle, createAttachmentBundle, event } from "./llmIntakeTestFixtures.ts";
import { registerRunsFixtureIntakeSkillWithControlled } from "./llmIntakeRunsFixtureIntakeSkillWithControlled.cases.ts";



describe("LLM intake runs", () => {
  registerRunsFixtureIntakeSkillWithControlled();
});
