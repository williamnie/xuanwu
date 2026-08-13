import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { recommendExecutorProfile, resolveExecutorSelection } from "./agentOrchestration.ts";

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

  test("preserves an assigned provider profile's empty model instead of leaking the project model", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, {
        defaultSkillPolicy: {},
        id: "demo",
        model: "codex-default",
        provider: "codex"
      });
      insertAgentProfile(db, "pi-local", "[]", { model: "", provider: "pi-coding-agent" });
      const piIssueID = insertIssue(db, "demo", "Use Pi provider default", "pi-local");
      const projectIssueID = insertIssue(db, "demo", "Use project default");
      const project = getProject(db, "demo")!;

      expect(resolveExecutorSelection(db, project, getIssue(db, piIssueID)!)).toMatchObject({
        model: "",
        profile_id: "pi-local",
        provider: "pi-coding-agent"
      });
      expect(resolveExecutorSelection(db, project, getIssue(db, projectIssueID)!)).toMatchObject({
        model: "codex-default",
        profile_id: "",
        provider: "codex"
      });
    } finally {
      db.close();
    }
  });

  test("inherits the project execution policy only when the selected profile has no policy", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, {
        defaultSkillPolicy: {},
        id: "demo",
        provider: "codex"
      });
      db.sqlite.run("update projects set execution_policy_json=? where id=?", [
        JSON.stringify({ contract: "xw.execution-policy.v1", access: "read-only", approval: "ask-sensitive" }),
        "demo"
      ]);
      insertAgentProfile(db, "inherit-policy", "[]");
      insertAgentProfile(db, "profile-policy", "[]");
      db.sqlite.run("update agent_profiles set execution_policy_json=? where id=?", [
        JSON.stringify({ contract: "xw.execution-policy.v1", access: "unrestricted-host", approval: "ask-every-side-effect" }),
        "profile-policy"
      ]);
      const inheritedIssueID = insertIssue(db, "demo", "Inherit project policy", "inherit-policy");
      const explicitIssueID = insertIssue(db, "demo", "Use profile policy", "profile-policy");
      const project = getProject(db, "demo")!;

      expect(resolveExecutorSelection(db, project, getIssue(db, inheritedIssueID)!)).toMatchObject({
        execution_policy: { access: "read-only", approval: "ask-sensitive" },
        execution_policy_source: "project"
      });
      expect(resolveExecutorSelection(db, project, getIssue(db, explicitIssueID)!)).toMatchObject({
        execution_policy: { access: "unrestricted-host", approval: "ask-every-side-effect" },
        execution_policy_source: "profile"
      });
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

function insertProject(db: RunnerDatabase, input: { defaultSkillPolicy: unknown; id: string; model?: string; provider: string }): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, model, default_skill_policy_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.id, `/tmp/${input.id}`, input.provider, input.model ?? "codex-default", JSON.stringify(input.defaultSkillPolicy),
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertAgentProfile(
  db: RunnerDatabase,
  id: string,
  skillIntents: string,
  input: { model?: string; provider?: string } = {}
): void {
  db.sqlite.run(
    `insert into agent_profiles (id, name, provider, model, skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, input.provider ?? "codex", input.model ?? "gpt-test", skillIntents,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, title: string, agentProfileID = ""): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, agent_profile_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    [projectID, title, "todo", agentProfileID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}
