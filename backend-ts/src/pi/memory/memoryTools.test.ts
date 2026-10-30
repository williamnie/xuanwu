import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import {
  createPiMemoryItem,
  getPiMemoryItem,
  listPiActionEvents,
  listPiActions,
  listPiMemoryItems,
  listPiMemoryHistory,
  rememberPiMemoryItem,
  updatePiMemoryItem,
  deletePiMemoryItem
} from "../../db/repositories/pi.ts";
import { createPiMemoryTools, PI_MEMORY_TOOL_NAMES } from "./memoryTools.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { retrievePiMemoryContext } from "./memoryContext.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, openFixture, toolByName, validateArgs, seedMemory, seedProjectPolicyFixture, policyMemory, itemIds, concurrentRemember } from "./memoryToolsTestFixtures.ts";
import { registerRemembersAnExplicitPreferenceAsActive } from "./memoryToolsRemembersAnExplicitPreferenceAsActive.cases.ts";
import { registerRetrievesProjectPolicyMemoryWithCorrect } from "./memoryToolsRetrievesProjectPolicyMemoryWithCorrect.cases.ts";
import { registerRejectsEveryForgedOrMismatchedExperience } from "./memoryToolsRejectsEveryForgedOrMismatchedExperience.cases.ts";



describe("PI memory tools", () => {
  registerRemembersAnExplicitPreferenceAsActive();
  registerRetrievesProjectPolicyMemoryWithCorrect();
  registerRejectsEveryForgedOrMismatchedExperience();
});
