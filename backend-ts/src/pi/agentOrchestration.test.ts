import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recommendExecutorProfile } from "./agentOrchestration.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI agent orchestration profile selection", () => {
  test("uses project default skill policy when selecting profile and skill intents", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, {
        defaultSkillPolicy: { required: ["verification-before-completion"], recommended: ["xuanwu"] },
        id: "demo",
        provider: "codex"
      });
      insertAgentProfile(db, "codex-general", "[]");
      insertAgentProfile(db, "codex-verifier", "[\"verification-before-completion\"]");
      const issueID = insertIssue(db, "demo", "Policy-driven execution");

      const recommendation = recommendExecutorProfile(db, undefined, { issue_id: issueID, role: "executor" });

      expect(recommendation).toMatchObject({
        profile_id: "codex-verifier",
        provider: "codex",
        recommended_skill_intents: ["xuanwu"],
        required_skill_intents: ["verification-before-completion"]
      });
      expect(recommendation.reason).toContain("matched role/provider/skill intent strategy");
      expect(recommendation.reason).toContain("codex-verifier");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-agent-orchestration-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, input: { defaultSkillPolicy: unknown; id: string; provider: string }): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, default_skill_policy_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.id, `/tmp/${input.id}`, input.provider, JSON.stringify(input.defaultSkillPolicy),
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertAgentProfile(db: RunnerDatabase, id: string, skillIntents: string): void {
  db.sqlite.run(
    `insert into agent_profiles (id, name, provider, model, skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, "codex", "gpt-test", skillIntents, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, title: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, title, "todo", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}
