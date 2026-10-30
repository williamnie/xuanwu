import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { runMigrations } from "../../db/migrations.ts";
import { migrations } from "../../db/schema/index.ts";
import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents,
  type readProjectPiPolicy,
  upsertProjectPiPolicy
} from "../../db/repositories/pi.ts";
import { classifyPiActionRisk } from "../actions/actionGate.ts";
import {
  PI_SUPERVISOR_ACTION_PAYLOAD_SCHEMAS,
  PI_SUPERVISOR_DECISION_ACTION_TYPES,
  PI_SUPERVISOR_DECISION_JSON_SCHEMA,
  PI_SUPERVISOR_DECISIONS,
  PI_SUPERVISOR_DIAGNOSIS_CODES
} from "./issueSupervisorRecovery.ts";
import {
  classifyRecoveryDiagnosis,
  isAutomaticRecoveryBlockedDiagnosis,
  isTransientRecoveryDiagnosis
} from "./recoveryDiagnosis.ts";
import { issueSupervisorRecoveryFixtures } from "./issueSupervisorRecoveryFixtures.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, tempRoots, openFixtureDatabase, tempPath, createLegacyDatabase, insertLegacyPolicyRow, supervisorMigrationIndex, tableNames, columnNames } from "./issue-supervisor-recoveryTestFixtures.ts";
import { registerDefinesDiagnosisCodesDecisionJSONSchema } from "./issue-supervisor-recoveryDefinesDiagnosisCodesDecisionJSONSchema.cases.ts";
import { registerMigratesLegacyDatabasesWithSupervisorEvent } from "./issue-supervisor-recoveryMigratesLegacyDatabasesWithSupervisorEvent.cases.ts";

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI issue supervisor recovery contract", () => {
  registerDefinesDiagnosisCodesDecisionJSONSchema();
  registerMigratesLegacyDatabasesWithSupervisorEvent();
});
