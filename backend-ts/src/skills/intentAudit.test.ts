import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createProject } from "../db/repositories/projects.ts";
import { auditIssueSkillIntents, listSkillIntentAudits } from "./intentAudit.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("skill intent audit", () => {
  test("records used, missing, and unauthorized skill intent evidence", async () => {
    const { cwd, db } = await openFixture();
    try {
      const project = createProject(db, {
        cwd,
        default_skill_policy: { allowed: ["xuanwu"] },
        id: "demo"
      });
      const issue = createIssue(db, {
        project_id: project.id,
        required_skill_intents: ["xuanwu", "verification-before-completion"],
        title: "Audit issue"
      });
      recordIssueEvent(db, issue.id, "issue.log", { text: "Using xuanwu skill to inspect runner state." });

      const audit = auditIssueSkillIntents(db, issue.id, { issueRunID: "issue-1-attempt-1" });
      const rows = listSkillIntentAudits(db, { issueID: issue.id });

      expect(audit).toMatchObject({
        issue_id: issue.id,
        issue_run_id: "issue-1-attempt-1",
        missing_skill_intents: ["verification-before-completion"],
        status: "mismatch",
        unauthorized_skill_intents: []
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ issue_id: issue.id, status: "mismatch" });
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<{ cwd: string; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-skill-audit-"));
  tempRoots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  return { cwd, db: await openDatabase({ stateDir: join(root, "state") }) };
}
