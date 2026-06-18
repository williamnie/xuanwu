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
  createPiDelegation,
  createPiMemoryItem,
  createProjectPiSettings,
  deletePiAction,
  deletePiAgent,
  deletePiConversation,
  deletePiMemoryItem,
  deleteProjectPiSettings,
  expirePiDelegation,
  getPiAction,
  getPiAgent,
  getPiConversation,
  getPiDelegation,
  getPiMemoryItem,
  getProjectPiSettings,
  listPiActionEvents,
  listPiActions,
  listPiAgents,
  listPiConversations,
  listPiDelegations,
  listPiMemoryItems,
  listProjectPiSettings,
  pausePiDelegation,
  resumePiDelegation,
  updatePiAction,
  updatePiAgent,
  updatePiConversation,
  updatePiDelegation,
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
        gate_decision: "",
        guardian_decision_id: "",
        idempotency_key: "",
        legacy_bypass_reason: "legacy_direct_action"
      });
      const guardianAction = createPiAction(db, {
        id: "action-guardian",
        action_type: "issue.enqueue",
        guardian_decision_id: "decision-1",
        idempotency_key: "decision-1:issue.enqueue:1",
        issue_id: 1,
        payload_json: "{\"issue_id\":1}",
        project_id: "demo",
        status: "approved"
      });
      const duplicateGuardianAction = createPiAction(db, {
        id: "action-guardian-duplicate",
        action_type: "issue.enqueue",
        guardian_decision_id: "decision-1",
        idempotency_key: "decision-1:issue.enqueue:1",
        issue_id: 1,
        payload_json: "{\"issue_id\":1}",
        project_id: "demo",
        status: "approved"
      });
      expect(guardianAction).toMatchObject({
        guardian_decision_id: "decision-1",
        idempotency_key: "decision-1:issue.enqueue:1",
        legacy_bypass_reason: ""
      });
      expect(duplicateGuardianAction.id).toBe(guardianAction.id);
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
      expect(listPiActions(db, { projectId: "demo" }).map((item) => item.id))
        .toEqual(["action-1", "action-guardian"]);

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
      expect(deletePiAction(db, "action-guardian")).toBe(true);
      expect(deletePiMemoryItem(db, "mem-1")).toBe(true);
      expect(getPiMemoryItem(db, "mem-1")).toBeNull();
      expect(deletePiConversation(db, "conv-1")).toBe(true);
      expect(getPiConversation(db, "conv-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("filters PI action events by delegation with stable redacted timeline rows", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createPiActionEvent(db, {
        action_id: "action-delegated",
        delegation_id: "delegation-a",
        error: "CODEX_API_KEY=fixture-secret at /Users/secret/log.txt",
        event_type: "execution_error",
        issue_id: 42,
        payload_json: JSON.stringify({
          auth_token: "payload-secret",
          cwd: "/Users/secret/project",
          nested: { api_key: "nested-secret" }
        }),
        project_id: "demo",
        result_json: JSON.stringify({ total_tokens: 5, output_path: "/tmp/secret/out.txt" })
      });
      createPiActionEvent(db, {
        action_id: "action-other",
        delegation_id: "delegation-b",
        event_type: "gate_decision",
        issue_id: 42,
        project_id: "demo"
      });
      const second = createPiActionEvent(db, {
        action_id: "action-delegated",
        delegation_id: "delegation-a",
        event_type: "execution_result",
        issue_id: 42,
        project_id: "demo"
      });

      const events = listPiActionEvents(db, { delegationId: "delegation-a", issueId: 42, projectId: "demo" });
      const payload = JSON.parse(events[0]?.payload_json ?? "{}") as Record<string, unknown>;
      const result = JSON.parse(events[0]?.result_json ?? "{}") as Record<string, unknown>;
      const text = JSON.stringify(events);

      expect(events.map((event) => event.id)).toEqual([first.id, second.id]);
      expect(payload).toMatchObject({
        auth_token: "[redacted]",
        cwd: "[redacted-path]",
        nested: { api_key: "[redacted]" }
      });
      expect(result).toMatchObject({ output_path: "[redacted-path]", total_tokens: 5 });
      expect(events[0]?.error).toContain("CODEX_API_KEY=[redacted]");
      expect(events[0]?.error).toContain("[redacted-path]");
      expect(text).not.toContain("fixture-secret");
      expect(text).not.toContain("payload-secret");
      expect(text).not.toContain("nested-secret");
      expect(text).not.toContain("/Users/secret");
      expect(text).not.toContain("/tmp/secret");
    } finally {
      db.close();
    }
  });

  test("persists delegation envelope fields with explicit defaults", async () => {
    const db = await openFixtureDatabase();
    try {
      const delegation = createPiDelegation(db, {
        authorization_json: JSON.stringify({
          allowed_actions: ["issue.enqueue"],
          allowed_mcp_capabilities: ["docs:resource:runbook"],
          allowed_skill_intents: ["codex-issue-runner"],
          audit_source: "user",
          expires_at: "2026-06-04T08:00:00Z",
          forbidden_actions: ["session.steer"],
          mode: "delegated",
          scope: { project_id: "demo" },
          starts_at: "2026-06-03T20:00:00Z"
        }),
        id: "delegation-1",
        project_id: "demo",
        title: "Night window"
      });

      expect(delegation).toMatchObject({
        allowed_actions_json: "[\"issue.enqueue\"]",
        allowed_mcp_capabilities_json: "[\"docs:resource:runbook\"]",
        allowed_skill_intents_json: "[\"codex-issue-runner\"]",
        audit_source: "user",
        expires_at: "2026-06-04T08:00:00Z",
        forbidden_actions_json: "[\"session.steer\"]",
        scope_json: "{\"project_id\":\"demo\"}",
        starts_at: "2026-06-03T20:00:00Z",
        status: "active"
      });
      expect(getPiDelegation(db, "delegation-1")).toMatchObject(delegation);
      expect(listPiDelegations(db, { projectId: "demo" }).map((item) => item.id)).toEqual(["delegation-1"]);

      const updated = updatePiDelegation(db, "delegation-1", {
        allowed_actions_json: ["issue.comment"],
        allowed_mcp_capabilities_json: ["docs:tool:search"],
        allowed_skill_intents_json: ["verification-before-completion"],
        audit_source: "cron",
        scope_json: { issue_id: 224 },
        status: "paused"
      });
      expect(updated).toMatchObject({
        allowed_actions_json: "[\"issue.comment\"]",
        allowed_mcp_capabilities_json: "[\"docs:tool:search\"]",
        allowed_skill_intents_json: "[\"verification-before-completion\"]",
        audit_source: "cron",
        scope_json: "{\"issue_id\":224}",
        status: "paused"
      });
    } finally {
      db.close();
    }
  });

  test("enforces delegation pause resume expire lifecycle transitions", async () => {
    const db = await openFixtureDatabase();
    try {
      createPiDelegation(db, { id: "delegation-life", project_id: "demo", status: "active" });
      expect(pausePiDelegation(db, "delegation-life")).toMatchObject({ status: "paused" });
      expect(resumePiDelegation(db, "delegation-life")).toMatchObject({ status: "active" });
      expect(pausePiDelegation(db, "delegation-life")).toMatchObject({ status: "paused" });
      expect(expirePiDelegation(db, "delegation-life")).toMatchObject({ status: "expired" });
      expect(listPiDelegations(db, { status: "expired" }).map((item) => item.id)).toEqual(["delegation-life"]);

      createPiDelegation(db, { id: "delegation-active-expire", project_id: "demo" });
      expect(expirePiDelegation(db, "delegation-active-expire")).toMatchObject({ status: "expired" });
      expect(() => resumePiDelegation(db, "delegation-life"))
        .toThrow("cannot transition PI delegation delegation-life from expired to active");
      expect(() => pausePiDelegation(db, "delegation-life"))
        .toThrow("cannot transition PI delegation delegation-life from expired to paused");
      expect(() => updatePiDelegation(db, "delegation-life", { status: "archived" }))
        .toThrow("unsupported PI delegation status: archived");
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
