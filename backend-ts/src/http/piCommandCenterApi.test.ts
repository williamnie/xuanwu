import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createPiAction,
  createPiDelegation,
  createPiHeartbeatRun,
  createPiMemoryItem,
  upsertPiApprovalRequest,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Command Center API", () => {
  test("aggregates only P11.01 mode, delegation, approval, and heartbeat card signals", async () => {
      const database = await openFixtureDatabase();
      try {
        insertProject(database, "demo");
        insertPiSettings(database, "demo");
        upsertProjectPiPolicy(database, {
          allowed_supervisor_actions_json: ["session.resume_followup"],
          project_id: "demo",
          supervisor_mode: "autonomous"
        });
        createPiDelegation(database, { project_id: "demo", status: "active", title: "Night window" });
      createPiAction(database, { action_type: "issue.enqueue", id: "act-1", project_id: "demo", status: "pending" });
      upsertPiApprovalRequest(database, {
        approval_id: "approval-cc-1",
        approval_source: "codex_provider_event",
        issue_id: 392,
        project_id: "demo",
        provider: "codex",
        request_summary: "command=git status",
        request_type: "command",
        status: "delivered"
      });
      createPiHeartbeatRun(database, { id: "hb-1", kind: "project", project_id: "demo", status: "completed" });
      createPiMemoryItem(database, {
        content: "Keep patches narrow",
        id: "active-memory",
        kind: "project_policy",
        scope: "project",
        scope_id: "demo"
      });
      createPiMemoryItem(database, {
        content: "Review repeated stream disconnects",
        disabled: 1,
        id: "candidate-memory",
        kind: "failure_pattern",
        scope: "project",
        scope_id: "demo",
        source_id: "pi-supervisor-298",
        source_type: "pi.supervisor"
      });

      const response = await createDefaultRouter({ database }).handle(new Request(`${BASE_URL}/api/pi/command-center`));
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ mode: "delegated" });
      expect(body.overview).toMatchObject({
        active_delegations: 1,
        autonomous_projects: 1,
        issue_auto_run_projects: 1,
        pending_approvals: 2
      });
      expect(body.automation).toMatchObject({
        issue_execution: {
          enabled_projects: 1,
          state: "enabled"
        },
        supervisor: {
          allowed_actions: ["session.resume_followup"],
          automatic_projects: 1,
          enabled: true,
          not_all_issues: true,
          scan_scope: "in_progress/open_issue_runs/due_auto_retry",
          targets: [expect.objectContaining({
            allowed_actions: ["session.resume_followup"],
            project_id: "demo",
            recovery_state: "auto_recoverable",
            supervisor_mode: "autonomous"
          })]
        },
        manager_auto_manage: {
          enabled_projects: 1,
          settings_table: "project_pi_settings",
          state: "enabled",
          targets: [{
            auto_manage: 1,
            project_id: "demo",
            runnable: true,
            settings_present: true
          }]
        },
        delegation_heartbeat: {
          active_delegations: 1,
          state: "enabled"
        }
      });
      expect(body.heartbeat).toMatchObject({
        latest_run: { id: "hb-1", status: "completed" },
        status: "completed"
      });
      expect(body.integrations).toMatchObject({
        feishu: {
          configured: false,
          receive_enabled: false,
          reply_mode: "draft",
          state: "disabled"
        }
      });
      expect(body.prompt_debug).toMatchObject({
        agent_id: "agent-1",
        runtime_prompt_summary: {
          custom_instructions_configured: true,
          custom_instructions_preview: "[hidden: custom instructions are active]",
          injected_after: "core PI role/safety/tool/MCP constraints"
        }
      });
      expect(body.memory).toMatchObject({
        active_count: 1,
        candidate_count: 1,
        recent_candidate_sources: [{
          id: "candidate-memory",
          kind: "failure_pattern",
          source_id: "pi-supervisor-298",
          source_type: "pi.supervisor"
        }],
        source_policy: {
          chat: "explicit_low_risk_preferences_auto_enable",
          failure_pattern_generator: "enabled_candidate_only",
          manager_cycle: "enabled_candidate_only",
          promote: "manual_review_required",
          supervisor: "enabled_candidate_only"
        }
      });
      expect(body.supervisor).toMatchObject({
        agent: {
          agent_id: "agent-1",
          source: "project_settings",
          status: "bound",
          status_text: "supervisor agent 已绑定 project settings"
        },
        policy: {
          automatic_projects: 1,
          targets: [expect.objectContaining({
            recovery_state: "auto_recoverable",
            state_text: "可自动恢复 allowlist 中的动作"
          })]
        }
      });
      expect(body).not.toHaveProperty("projects");
      expect(body).not.toHaveProperty("reports");
      expect(body).not.toHaveProperty("audit_events");
    } finally {
      database.close();
    }
  });

  test("reports supervisor global agent fallback when project PI settings are absent", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertAgent(database, "runner-default", "石头");

      const response = await createDefaultRouter({ database }).handle(new Request(`${BASE_URL}/api/pi/command-center`));
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        supervisor: {
          agent: {
            agent_id: "runner-default",
            agent_name: "石头",
            source: "global_fallback",
            status: "fallback",
            status_text: "supervisor agent 未绑定 project settings，已 fallback 到全局 PI agent"
          }
        }
      });
      expect(body).toMatchObject({
        mode: "manual",
        overview: {
          autonomous_projects: 0
        },
        heartbeat: {
          status: "idle"
        },
        automation: {
          manager_auto_manage: {
            enabled_projects: 0,
            missing_settings_projects: 1,
            reason: expect.stringContaining("project_pi_settings.auto_manage=1"),
            state: "idle",
            targets: [{
              project_id: "demo",
              reason: "project_pi_settings 未创建",
              runnable: false,
              settings_present: false
            }]
          },
          delegation_heartbeat: {
            active_delegations: 0,
            reason: "没有 active pi_delegations，delegation heartbeat 不会创建 pi_heartbeat_runs",
            state: "idle"
          },
          cron_heartbeat: {
            active_tasks: 0,
            state: "idle"
          },
          supervisor: {
            not_all_issues: true,
            reason: expect.stringContaining("watchdog"),
            targets: [expect.objectContaining({
              allowed_actions: [],
              recovery_state: "watchdog",
              state_text: expect.stringContaining("watchdog"),
              supervisor_mode: "watchdog"
            })]
          }
        }
      });
      expect(body.supervisor).toMatchObject({
        policy: {
          automatic_projects: 0,
          needs_approval_projects: 0,
          targets: [expect.objectContaining({
            recovery_state: "watchdog"
          })]
        }
      });
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-command-center-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}

function insertPiSettings(db: RunnerDatabase, projectID: string): void {
  insertAgent(db, "agent-1", "PI");
  db.sqlite.run(
    `insert into project_pi_settings (project_id, pi_agent_id, auto_manage, auto_triage, auto_enqueue, notify_on_needs_user, max_actions_per_cycle, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectID, "agent-1", 1, 0, 0, 1, 5, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}

function insertAgent(db: RunnerDatabase, id: string, name: string): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, provider, model_provider, model_id, thinking_level, cwd_policy, tools_json, instructions, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, "pi-sdk", "openai", "gpt-5.4", "high", "project", "[]", "每轮先输出托管策略摘要。", 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}
