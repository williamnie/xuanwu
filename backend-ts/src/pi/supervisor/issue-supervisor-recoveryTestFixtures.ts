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

export const trackDatabase = useDatabaseCleanup();

export const tempRoots: string[] = [];

export async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await tempPath("xuanwu-supervisor-");
  return openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
}

export async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

export async function createLegacyDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  runMigrations(db, migrations.slice(0, supervisorMigrationIndex()));
}

export async function insertLegacyPolicyRow(path: string): Promise<void> {
  const db = new Database(path);
  try {
    db.run(`insert into project_pi_policies
      (project_id, default_mode, timezone, working_hours_json, quiet_hours_json,
        retry_policy_json, concurrency_policy_json,
        allowed_actions_json, allowed_mcp_capabilities_json, allowed_skill_intents_json,
        created_at, updated_at)
      values ('legacy-demo', 'manual', 'UTC', '{}', '{}',
        '{"enabled":false,"max_attempts":0,"backoff_minutes":[]}',
        '{"max_parallel_issues":1,"max_parallel_pi_cycles":1}',
        '[]', '[]', '[]', '2026-06-10T00:00:00Z', '2026-06-10T00:00:00Z')`);
  } finally {
    db.close();
  }
}

export function supervisorMigrationIndex(): number {
  const index = migrations.findIndex((migration) => migration.id === "020_issue_supervisor_recovery");
  if (index < 0) throw new Error("supervisor recovery migration missing");
  return index;
}

export function tableNames(connection: RunnerDatabase): string[] {
  return connection.sqlite.query("select name from sqlite_master where type='table' order by name asc")
    .all().map((row) => (row as { name: string }).name);
}

export function columnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma table_info(${table})`).all()
    .map((row) => (row as { name: string }).name);
}
