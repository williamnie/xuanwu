import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createPiAction, listPiActionEvents } from "../db/repositories/pi/actions.ts";
import {
  SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA,
  recordSupervisorContextResolutionAudit,
  resolveSupervisorContext,
  supervisorContextPrompt
} from "./supervisorContextResolver.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Xuanwu Supervisor project, Work and conversation context resolver", () => {
  test("resolves an explicit Work through the authoritative Work adapter with scored provenance", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "runner-api", "Runner API");
      insertProject(db, "runner-web", "Runner Web");
      const issue = createIssue(db, {
        project_id: "runner-web",
        status: "todo",
        title: "Fix web context"
      });

      const resolution = resolveSupervisorContext(db, {
        conversationID: "local-conversation",
        conversationProjectID: "runner-api",
        prompt: `继续处理 xw:work:issues:${issue.id}`,
        source: "runner_chat"
      });

      expect(Value.Check(SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA, resolution)).toBe(true);
      expect(resolution).toMatchObject({
        reason: "single consistent direct target",
        status: "resolved",
        target: {
          issue_ids: [issue.id],
          project_id: "runner-web",
          work_ids: [`xw:work:issues:${issue.id}`]
        }
      });
      expect(resolution.candidates[0]).toMatchObject({
        project_id: "runner-web",
        score: 100,
        sources: [{ kind: "work_reference", ref: `xw:work:issues:${issue.id}`, score: 100 }]
      });
      expect(resolution.candidates).toContainEqual(expect.objectContaining({
        project_id: "runner-api",
        sources: [expect.objectContaining({ kind: "current_page" })]
      }));
    } finally {
      db.close();
    }
  });

  test("resolves the Chinese bare issue phrasing used by IM replies to exact Work", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "runner-web", "Runner Web");
      const issue = createIssue(db, { project_id: "runner-web", status: "todo", title: "Memory regression" });
      const resolution = resolveSupervisorContext(db, {
        prompt: `那就是${issue.id}中的修复没修复好，内存仍然超了`,
        source: "feishu_runner_chat"
      });

      expect(resolution).toMatchObject({
        status: "resolved",
        target: {
          issue_ids: [issue.id],
          project_id: "runner-web",
          work_ids: [`xw:work:issues:${issue.id}`]
        }
      });
    } finally {
      db.close();
    }
  });

  test("fails closed when explicit text or Work refs span multiple projects", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "runner-api", "Runner API");
      insertProject(db, "runner-web", "Runner Web");
      const api = createIssue(db, { project_id: "runner-api", status: "todo", title: "API" });
      const web = createIssue(db, { project_id: "runner-web", status: "todo", title: "Web" });

      for (const prompt of [
        "比较 runner-api 和 runner-web 的状态",
        `继续 #${api.id} 和 #${web.id}`
      ]) {
        const resolution = resolveSupervisorContext(db, { prompt, source: "runner_chat" });
        expect(resolution).toMatchObject({
          reason: "conflicting direct project or Work context",
          status: "ambiguous",
          target: { issue_ids: [], project_id: "", work_ids: [] },
          clarification: { required: true }
        });
        expect(resolution.candidates.map((candidate) => candidate.project_id).sort())
          .toEqual(["runner-api", "runner-web"]);
      }
    } finally {
      db.close();
    }
  });

  test("uses one-shot IM targets for one turn without persisting Project context", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "Demo");
      const selected = resolveSupervisorContext(db, {
        conversationID: "feishu-chat-a",
        conversationProjectID: "demo",
        oneShotProjectID: "demo",
        oneShotSource: "mapping_default",
        prompt: "开始处理",
        source: "feishu_runner_chat"
      });
      const later = resolveSupervisorContext(db, {
        conversationID: "feishu-chat-a",
        conversationProjectID: "demo",
        prompt: "继续处理",
        source: "feishu_runner_chat"
      });

      expect(selected).toMatchObject({
        status: "resolved",
        target: { project_id: "demo" },
        provenance: {
          context_inheritance_allowed: false,
          source: "feishu_runner_chat",
          target_binding: "one_shot"
        }
      });
      expect(selected.candidates[0]?.sources).toContainEqual({
        kind: "one_shot_target",
        ref: "mapping_default",
        score: 96
      });
      expect(later).toMatchObject({
        reason: "no deterministic project or Work context",
        status: "missing",
        target: { project_id: "" },
        provenance: { context_inheritance_allowed: false, target_binding: "none" }
      });
    } finally {
      db.close();
    }
  });

  test("resolves a short IM continuation to the exact notified Work for one turn", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "Demo");
      const issue = createIssue(db, { project_id: "demo", status: "todo", title: "Notified work" });

      const resolution = resolveSupervisorContext(db, {
        conversationID: "feishu-chat-oc_group",
        oneShotIssueID: issue.id,
        oneShotProjectID: "demo",
        oneShotSource: "latest_actionable_notification",
        prompt: "验收",
        source: "feishu_runner_chat"
      });

      expect(resolution).toMatchObject({
        reason: "single consistent direct target",
        status: "resolved",
        target: {
          issue_ids: [issue.id],
          project_id: "demo",
          work_ids: [`xw:work:issues:${issue.id}`]
        }
      });
      expect(resolution.candidates[0]?.sources).toContainEqual({
        kind: "one_shot_work",
        ref: `xw:work:issues:${issue.id}:latest_actionable_notification`,
        score: 100
      });
    } finally {
      db.close();
    }
  });

  test("keeps local history continuity but never carries it into IM transports", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "Demo");
      const issue = createIssue(db, { project_id: "demo", status: "todo", title: "History" });
      createPiAction(db, {
        action_type: "issue.enqueue",
        conversation_id: "local-history",
        id: "history-action",
        issue_id: issue.id,
        project_id: "demo",
        status: "completed"
      });

      const local = resolveSupervisorContext(db, {
        conversationID: "local-history",
        prompt: "继续处理",
        source: "runner_chat"
      });
      const crossChannel = resolveSupervisorContext(db, {
        conversationID: "local-history",
        prompt: "继续处理",
        source: "feishu_runner_chat"
      });

      expect(local).toMatchObject({
        reason: "highest deterministic context score",
        status: "resolved",
        target: {
          issue_ids: [issue.id],
          project_id: "demo",
          work_ids: [`xw:work:issues:${issue.id}`]
        }
      });
      expect(local.candidates[0]?.sources).toEqual([{
        kind: "conversation_history",
        ref: "pi_actions:history-action",
        score: 55
      }]);
      expect(crossChannel).toMatchObject({
        reason: "no deterministic project or Work context",
        status: "missing",
        target: {
          issue_ids: [],
          project_id: "",
          work_ids: []
        },
        provenance: { context_inheritance_allowed: false, target_binding: "none" }
      });
    } finally {
      db.close();
    }
  });

  test("audits explainable resolution without persisting the raw prompt", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "Demo");
      const rawPrompt = "请检查 demo 的 private prompt fixture";
      const resolution = resolveSupervisorContext(db, { prompt: rawPrompt, source: "runner_chat" });
      recordSupervisorContextResolutionAudit(db, {
        conversationID: "audit-conversation",
        turnID: "turn-a"
      }, resolution);
      const events = listPiActionEvents(db, {
        conversationId: "audit-conversation",
        eventType: "supervisor_context_resolved"
      });
      const projection = supervisorContextPrompt(resolution);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action_id: "context-resolution:turn-a",
        actor: "supervisor_context_resolver",
        decision: "resolved",
        project_id: "demo"
      });
      expect(events[0]?.payload_json).not.toContain(rawPrompt);
      expect(events[0]?.payload_json).toContain(resolution.input_audit.input_digest);
      expect(projection).toContain("A one-shot target never rebinds the conversation");
      expect(projection).toContain("Candidate scores only rank deterministic evidence");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-supervisor-context-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string, name: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, 'codex', 1, ?, ?)`,
    [id, name, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
