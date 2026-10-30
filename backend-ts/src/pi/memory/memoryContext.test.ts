import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { buildPiMemoryPromptContext, retrievePiMemoryContext } from "./memoryContext.ts";
import { createPiMemoryItem, deletePiMemoryItem, updatePiMemoryItem } from "../../db/repositories/pi.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { MEMORY_SCAN_LIMIT } from "./memoryRetrieval.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, insertMemory } from "./memoryContextTestFixtures.ts";
import { registerLoadsConfirmedProjectGlobalMemoriesAnd } from "./memoryContextLoadsConfirmedProjectGlobalMemoriesAnd.cases.ts";
import { registerExplainsSelectedMemoriesWithProvenanceAnd } from "./memoryContextExplainsSelectedMemoriesWithProvenanceAnd.cases.ts";
import { registerRecallsSynonymsErrorKeywordsAndPaths } from "./memoryContextRecallsSynonymsErrorKeywordsAndPaths.cases.ts";



describe("PI memory prompt context", () => {
  registerLoadsConfirmedProjectGlobalMemoriesAnd();
  registerExplainsSelectedMemoriesWithProvenanceAnd();
});

describe("task-scoped experience retrieval", () => {
  registerRecallsSynonymsErrorKeywordsAndPaths();
});
