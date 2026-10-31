import { describe } from "bun:test";
import { registerRunAttemptMigrationBackfillCases } from "./runAttemptMigrationBackfillCases.ts";

describe("Run/Attempt relation migration", () => {
  registerRunAttemptMigrationBackfillCases();
});
