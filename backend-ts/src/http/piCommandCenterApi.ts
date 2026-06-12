import type { RunnerDatabase } from "../db/database.ts";
import type { RunnerConfig } from "../config/env.ts";
import { feishuConnectorStatus } from "../integrations/feishu.ts";
import { listCronTasks } from "../db/repositories/cronTasks.ts";
import {
  getPiAgent,
  listPiAgents,
  listPiActions,
  listPiConversations,
  listPiDelegations,
  listPiHeartbeatRuns,
  listPiMemoryItems,
  listIssueSupervisorEvents,
  listProjectPiSettings,
  type PiMemoryItem,
  type PiHeartbeatRun
} from "../db/repositories/pi.ts";
import { listProjects, type Project } from "../db/repositories/projects.ts";
import type { Router } from "./router.ts";
import { json } from "./errors.ts";
import { piRuntimePromptSummary } from "./piRuntimePrompt.ts";
import { supervisorPolicySummary, supervisorScanSummary } from "./piCommandCenterSupervisorPolicy.ts";

type PiCommandCenterContext = { config?: RunnerConfig; database: RunnerDatabase };

export function registerPiCommandCenterRoutes(router: Router, context: PiCommandCenterContext): void {
  router.get("/api/pi/command-center", () => json(buildPiCommandCenter(context)));
}

function buildPiCommandCenter(context: PiCommandCenterContext) {
  const db = context.database;
  const projects = listProjects(db);
  const settings = listProjectPiSettings(db);
  const activeDelegations = listPiDelegations(db, { status: "active" });
  const pendingApprovals = listPiActions(db, { status: "pending" });
  const latestRun = listPiHeartbeatRuns(db).at(0) ?? null;
  const supervisorEvents = listIssueSupervisorEvents(db);
  const memoryItems = listPiMemoryItems(db);
  const cronTasks = listCronTasks(db);
  const autoManagedProjects = runnableAutoManagedProjectCount(db, settings);

  return {
    automation: automationSummary(db, { activeDelegations, cronTasks, projects, settings }),
    generated_at: new Date().toISOString(),
    mode: commandMode(autoManagedProjects, activeDelegations.length, settings.length),
    integrations: integrationSummary(context),
    overview: {
      active_delegations: activeDelegations.length,
      autonomous_projects: autoManagedProjects,
      issue_auto_run_projects: projects.filter((project) => project.auto_run === 1).length,
      pending_approvals: pendingApprovals.length
    },
    heartbeat: heartbeatSummary(latestRun),
    memory: memorySummary(memoryItems),
    prompt_debug: promptDebug(db, settings),
    supervisor: supervisorSummary(db, supervisorEvents, projects, settings)
  };
}

type CommandCenterInputs = {
  activeDelegations: ReturnType<typeof listPiDelegations>;
  cronTasks: ReturnType<typeof listCronTasks>;
  projects: Project[];
  settings: ReturnType<typeof listProjectPiSettings>;
};

const HEARTBEAT_CRON_ACTIONS = new Set(["run_heartbeat", "run_pi_cycle"]);

function automationSummary(db: RunnerDatabase, input: CommandCenterInputs) {
  const activeCronTasks = input.cronTasks.filter((task) =>
    task.status === "active" && HEARTBEAT_CRON_ACTIONS.has(task.action)
  );
  const issueAutoRunProjects = input.projects.filter((project) => project.auto_run === 1).length;
  const autoManagedProjects = runnableAutoManagedProjectCount(db, input.settings);
  return {
    cron_heartbeat: cronHeartbeatSummary(activeCronTasks),
    delegation_heartbeat: delegationHeartbeatSummary(input.activeDelegations.length),
    issue_execution: issueExecutionSummary(issueAutoRunProjects, input.projects.length),
    manager_auto_manage: managerAutoManageSummary(db, input, autoManagedProjects),
    supervisor: supervisorScanSummary(db, input.projects, input.settings)
  };
}
function issueExecutionSummary(enabledProjects: number, totalProjects: number) {
  return {
    enabled_projects: enabledProjects,
    reason: enabledProjects > 0
      ? "projects.auto_run=1 的项目会自动领取 todo issue；这不是 PI 项目巡检"
      : "没有 projects.auto_run=1 的项目，todo issue 不会自动领取",
    state: enabledProjects > 0 ? "enabled" : "idle",
    total_projects: totalProjects
  };
}
function managerAutoManageSummary(
  db: RunnerDatabase,
  input: Pick<CommandCenterInputs, "projects" | "settings">,
  enabledProjects: number
) {
  const settingsMap = settingsByProject(input.settings);
  return {
    enabled_projects: enabledProjects,
    latest_cycle: latestManagerCycle(db),
    missing_settings_projects: input.projects.filter((project) => !settingsMap.has(project.id)).length,
    reason: enabledProjects > 0
      ? "只会巡检 project_pi_settings.auto_manage=1 且 agent enabled 的项目"
      : "没有 project_pi_settings.auto_manage=1 且 agent enabled 的项目，PI manager cycle 不会运行",
    settings_table: "project_pi_settings",
    state: enabledProjects > 0 ? "enabled" : "idle",
    targets: input.projects.map((project) => managerTarget(db, project, settingsMap.get(project.id))),
    total_projects: input.projects.length
  };
}
function delegationHeartbeatSummary(activeDelegations: number) {
  return {
    active_delegations: activeDelegations,
    reason: activeDelegations > 0
      ? "active pi_delegations 会按 next_heartbeat_at 创建 heartbeat run"
      : "没有 active pi_delegations，delegation heartbeat 不会创建 pi_heartbeat_runs",
    state: activeDelegations > 0 ? "enabled" : "idle"
  };
}
function cronHeartbeatSummary(activeTasks: ReturnType<typeof listCronTasks>) {
  return {
    active_tasks: activeTasks.length,
    reason: activeTasks.length > 0
      ? "active cron task 会按 next_run_at 触发 run_heartbeat/run_pi_cycle"
      : "没有 active run_heartbeat/run_pi_cycle cron task",
    state: activeTasks.length > 0 ? "enabled" : "idle",
    tasks: activeTasks.slice(0, 5).map((task) => ({
      action: task.action,
      id: task.id,
      name: task.name,
      next_run_at: task.next_run_at,
      project_id: task.project_id
    }))
  };
}
function settingsByProject(settings: ReturnType<typeof listProjectPiSettings>) {
  return new Map(settings.map((item) => [item.project_id, item]));
}
function runnableAutoManagedProjectCount(db: RunnerDatabase, settings: ReturnType<typeof listProjectPiSettings>) {
  return settings.filter((item) => item.auto_manage === 1 && getPiAgent(db, item.pi_agent_id)?.enabled === 1).length;
}
function managerTarget(
  db: RunnerDatabase,
  project: Project,
  settings: ReturnType<typeof listProjectPiSettings>[number] | undefined
) {
  const agent = settings?.pi_agent_id ? getPiAgent(db, settings.pi_agent_id) : null;
  return {
    agent_enabled: agent?.enabled === 1,
    auto_enqueue: settings?.auto_enqueue ?? 0,
    auto_manage: settings?.auto_manage ?? 0,
    auto_triage: settings?.auto_triage ?? 0,
    max_actions_per_cycle: settings?.max_actions_per_cycle ?? 5,
    pi_agent_id: settings?.pi_agent_id ?? "",
    project_id: project.id,
    project_name: project.name,
    reason: managerTargetReason(settings, agent?.enabled === 1),
    runnable: Boolean(settings && settings.auto_manage === 1 && agent?.enabled === 1),
    settings_present: Boolean(settings),
    updated_at: settings?.updated_at ?? ""
  };
}
function managerTargetReason(
  settings: ReturnType<typeof listProjectPiSettings>[number] | undefined,
  agentEnabled: boolean
): string {
  if (!settings) return "project_pi_settings 未创建";
  if (settings.auto_manage !== 1) return "auto_manage 未启用";
  if (settings.pi_agent_id === "") return "PI agent 未绑定";
  if (!agentEnabled) return "PI agent 不存在或未启用";
  return "project PI auto-manage 已启用";
}
function latestManagerCycle(db: RunnerDatabase) {
  const cycle = listPiConversations(db).find((item) => item.title === "PI manager cycle");
  if (!cycle) return null;
  return {
    id: cycle.id,
    pi_agent_id: cycle.pi_agent_id,
    pi_session_id: cycle.pi_session_id,
    project_id: cycle.project_id,
    status: cycle.status,
    updated_at: cycle.updated_at
  };
}

function integrationSummary(context: PiCommandCenterContext) {
  const feishu = feishuConnectorStatus(context.config?.integrations.feishu ?? {
    allowedChatIds: [],
    allowedUserIds: [],
    appId: "",
    appSecret: "",
    encryptKey: "",
    projectMappings: [],
    verificationToken: ""
  });
  return { feishu: feishu.summary };
}

function memorySummary(items: PiMemoryItem[]) {
  const active = items.filter((item) => item.disabled === 0);
  const candidates = items.filter((item) => item.disabled === 1);
  return {
    active_count: active.length,
    candidate_count: candidates.length,
    recent_candidate_sources: candidates.slice(0, 5).map(memoryCandidateSource),
    source_policy: {
      chat: "enabled_candidate_only",
      manager_cycle: "enabled_candidate_only",
      supervisor: "enabled_candidate_only",
      failure_pattern_generator: "enabled_candidate_only",
      promote: "manual_review_required"
    }
  };
}

function memoryCandidateSource(item: PiMemoryItem) {
  return {
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    scope_id: item.scope_id,
    source_id: item.source_id,
    source_type: item.source_type,
    updated_at: item.updated_at
  };
}

function promptDebug(db: RunnerDatabase, settings: ReturnType<typeof listProjectPiSettings>) {
  const agentID = settings.find((item) => item.auto_manage === 1)?.pi_agent_id ||
    settings[0]?.pi_agent_id ||
    listPiAgents(db).find((agent) => agent.enabled === 1)?.id ||
    "";
  const agent = agentID ? getPiAgent(db, agentID) : null;
  return agent ? { agent_id: agent.id, runtime_prompt_summary: piRuntimePromptSummary(agent) } : null;
}

function supervisorSummary(
  db: RunnerDatabase,
  events: ReturnType<typeof listIssueSupervisorEvents>,
  projects: Project[],
  settings: ReturnType<typeof listProjectPiSettings>
) {
  return {
    agent: supervisorAgentStatus(db, settings),
    latest_event: events.at(-1) ?? null,
    needs_user_escalations: events.filter((event) => event.action_type === "needs_user.escalate" || event.decision === "needs_user").length,
    policy: supervisorPolicySummary(db, projects, settings),
    rate_limit_waits: events.filter((event) => event.action_type === "issue.retry_after" || event.retry_after_at !== "").length,
    recovery_actions: events.filter((event) => event.event_type === "action").length
  };
}

function supervisorAgentStatus(db: RunnerDatabase, settings: ReturnType<typeof listProjectPiSettings>) {
  const configured = settings.find((item) => item.auto_manage === 1) ?? settings[0];
  if (configured) return configuredSupervisorAgentStatus(db, configured.pi_agent_id);
  const fallback = listPiAgents(db).find((agent) => agent.enabled === 1);
  if (fallback) {
    return {
      agent_id: fallback.id,
      agent_name: fallback.name,
      source: "global_fallback",
      status: "fallback",
      status_text: "supervisor agent 未绑定 project settings，已 fallback 到全局 PI agent"
    };
  }
  return {
    agent_id: "",
    agent_name: "",
    source: "missing",
    status: "needs_configuration",
    status_text: "supervisor agent 未绑定且没有 enabled 全局 PI agent，请绑定或启用一个 PI agent"
  };
}

function configuredSupervisorAgentStatus(db: RunnerDatabase, agentID: string) {
  const agent = getPiAgent(db, agentID);
  if (agent?.enabled === 1) {
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      source: "project_settings",
      status: "bound",
      status_text: "supervisor agent 已绑定 project settings"
    };
  }
  return {
    agent_id: agentID,
    agent_name: agent?.name ?? "",
    source: "project_settings",
    status: "needs_configuration",
    status_text: "supervisor agent 未可执行，请重新绑定 enabled PI agent"
  };
}

function commandMode(autoManagedProjects: number, activeDelegations: number, settingsCount: number): string {
  if (autoManagedProjects > 0 || activeDelegations > 0) return "delegated";
  if (settingsCount > 0) return "attended";
  return "manual";
}

function heartbeatSummary(latestRun: PiHeartbeatRun | null) {
  return {
    latest_run: latestRun,
    status: latestRun?.status || "idle"
  };
}
