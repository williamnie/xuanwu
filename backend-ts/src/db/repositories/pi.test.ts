import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { getIssue, listIssues } from "./issues.ts";
import {
  createPiAction,
  createPiActionEvent,
  createPiAgent,
  createPiConversation,
  createPiMemoryItem,
  createProjectPiSettings,
  deletePiAction,
  deletePiAgent,
  deletePiConversation,
  deletePiMemoryItem,
  deleteProjectPiSettings,
  getPiAction,
  getPiAgent,
  getPiConversation,
  getPiMemoryItem,
  getProjectPiSettings,
  listPiActionEvents,
  listPiActions,
  listPiAgents,
  listPiConversations,
  listPiMemoryItems,
  listProjectPiSettings,
  updatePiAction,
  updatePiAgent,
  updatePiConversation,
  updatePiMemoryItem,
  updateProjectPiSettings
} from "./pi.ts";
import { listProjects } from "./projects.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-repo-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI runtime repositories", () => {
  test("performs CRUD for PI agents and project settings", async () => {
    const db = await openFixtureDatabase();
    try {
      const agent = createPiAgent(db, { id: "agent-1", name: "Default PI" });
      expect(agent).toMatchObject({
        id: "agent-1",
        name: "Default PI",
        provider: "pi-sdk",
        thinking_level: "medium",
        tools_json: "[]",
        enabled: 1
      });

      const updatedAgent = updatePiAgent(db, "agent-1", {
        model_id: "gpt-5.4",
        tools_json: "[\"read\"]",
        enabled: 0
      });
      expect(updatedAgent).toMatchObject({ model_id: "gpt-5.4", tools_json: "[\"read\"]", enabled: 0 });
      expect(listPiAgents(db).map((item) => item.id)).toEqual(["agent-1"]);

      const settings = createProjectPiSettings(db, { project_id: "demo", pi_agent_id: "agent-1" });
      expect(settings).toMatchObject({
        project_id: "demo",
        pi_agent_id: "agent-1",
        auto_manage: 0,
        notify_on_needs_user: 1,
        max_actions_per_cycle: 5
      });

      const updatedSettings = updateProjectPiSettings(db, "demo", {
        auto_manage: 1,
        max_actions_per_cycle: 3
      });
      expect(updatedSettings).toMatchObject({ auto_manage: 1, max_actions_per_cycle: 3 });
      expect(listProjectPiSettings(db).map((item) => item.project_id)).toEqual(["demo"]);

      expect(deleteProjectPiSettings(db, "demo")).toBe(true);
      expect(getProjectPiSettings(db, "demo")).toBeNull();
      expect(deletePiAgent(db, "agent-1")).toBe(true);
      expect(getPiAgent(db, "agent-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("performs CRUD for PI conversations, actions, and memory items", async () => {
    const db = await openFixtureDatabase();
    try {
      createPiAgent(db, { id: "agent-1", name: "Default PI" });

      const conversation = createPiConversation(db, {
        id: "conv-1",
        project_id: "demo",
        pi_agent_id: "agent-1",
        title: "Plan"
      });
      expect(conversation).toMatchObject({ id: "conv-1", status: "active", title: "Plan" });
      expect(updatePiConversation(db, "conv-1", {
        pi_session_id: "pi-session-1",
        status: "archived"
      })).toMatchObject({ pi_session_id: "pi-session-1", status: "archived" });
      expect(listPiConversations(db, { projectId: "demo" }).map((item) => item.id)).toEqual(["conv-1"]);

      const action = createPiAction(db, {
        id: "action-1",
        project_id: "demo",
        issue_id: 1,
        conversation_id: "conv-1",
        action_type: "issue_create",
        status: "proposed",
        payload_json: "{\"title\":\"x\"}"
      });
      expect(action).toMatchObject({
        risk_level: "low",
        requires_confirmation: 0,
        result_json: "{}",
        source: "",
        gate_decision: ""
      });
      const auditEvent = createPiActionEvent(db, {
        action_id: action.id,
        actor: "pi",
        decision: "ask",
        event_type: "gate_decision",
        project_id: "demo",
        reason: "requires confirmation"
      });
      expect(auditEvent).toMatchObject({
        action_id: "action-1",
        actor: "pi",
        decision: "ask",
        event_type: "gate_decision",
        project_id: "demo",
        reason: "requires confirmation"
      });
      expect(listPiActionEvents(db, { actionId: "action-1" }).map((event) => event.event_type)).toEqual([
        "gate_decision"
      ]);
      expect(updatePiAction(db, "action-1", {
        result_json: "{\"ok\":true}",
        status: "done"
      })).toMatchObject({ result_json: "{\"ok\":true}", status: "done" });
      expect(listPiActions(db, { projectId: "demo" }).map((item) => item.id)).toEqual(["action-1"]);

      const memory = createPiMemoryItem(db, {
        id: "mem-1",
        scope: "project",
        scope_id: "demo",
        kind: "preference",
        content: "Prefer small patches"
      });
      expect(memory).toMatchObject({ confidence: "medium", pinned: 0, disabled: 0 });
      expect(updatePiMemoryItem(db, "mem-1", { pinned: 1, disabled: 1 }))
        .toMatchObject({ pinned: 1, disabled: 1 });
      expect(listPiMemoryItems(db, { scope: "project", scopeId: "demo" }).map((item) => item.id)).toEqual(["mem-1"]);

      expect(deletePiAction(db, "action-1")).toBe(true);
      expect(getPiAction(db, "action-1")).toBeNull();
      expect(deletePiMemoryItem(db, "mem-1")).toBe(true);
      expect(getPiMemoryItem(db, "mem-1")).toBeNull();
      expect(deletePiConversation(db, "conv-1")).toBe(true);
      expect(getPiConversation(db, "conv-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("keeps legacy projects and issues readable after PI migration", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      expect(listProjects(db).map((item) => item.id)).toEqual(["demo"]);
      expect(listIssues(db, { projectId: "demo" }).map((item) => item.id)).toEqual([issueId]);
      expect(getIssue(db, issueId)).toMatchObject({ id: issueId, project_id: "demo", title: "Legacy issue" });
    } finally {
      db.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectId, "Legacy issue", "todo", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
