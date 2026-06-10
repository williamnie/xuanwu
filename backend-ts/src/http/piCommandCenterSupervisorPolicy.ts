import type { RunnerDatabase } from "../db/database.ts";
import {
  getPiAgent,
  listPiAgents,
  readProjectPiPolicy,
  type ProjectPiSettings
} from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";

const SUPERVISOR_SCAN_LIMIT = 50;
const SUPERVISOR_SCAN_SCOPE = "in_progress/open_issue_runs/due_auto_retry";

export function supervisorScanSummary(
  db: RunnerDatabase,
  projects: Project[],
  settings: ProjectPiSettings[]
) {
  const targets = supervisorPolicyTargets(db, projects, settings);
  const automaticProjects = targets.filter((target) => target.recovery_state === "auto_recoverable").length;
  const approvalProjects = targets.filter((target) => target.recovery_state === "needs_approval").length;
  return {
    allowed_actions: [...new Set(targets.flatMap((target) => target.allowed_actions))],
    automatic_projects: automaticProjects,
    enabled: true,
    limit: SUPERVISOR_SCAN_LIMIT,
    needs_approval_projects: approvalProjects,
    not_all_issues: true,
    reason: supervisorScanReason(automaticProjects, approvalProjects),
    scan_scope: SUPERVISOR_SCAN_SCOPE,
    state: automaticProjects > 0 ? "enabled" : "idle",
    targets
  };
}

export function supervisorPolicySummary(
  db: RunnerDatabase,
  projects: Project[],
  settings: ProjectPiSettings[]
) {
  const targets = supervisorPolicyTargets(db, projects, settings);
  return {
    automatic_projects: targets.filter((target) => target.recovery_state === "auto_recoverable").length,
    default_state_text: targets[0]?.state_text ?? "暂无项目可配置 supervisor policy",
    needs_approval_projects: targets.filter((target) => target.recovery_state === "needs_approval").length,
    targets: targets.slice(0, 10)
  };
}

function supervisorPolicyTargets(db: RunnerDatabase, projects: Project[], settings: ProjectPiSettings[]) {
  const settingsMap = new Map(settings.map((item) => [item.project_id, item]));
  return projects.map((project) => supervisorPolicyTarget(db, project, settingsMap.get(project.id)));
}

function supervisorPolicyTarget(
  db: RunnerDatabase,
  project: Project,
  settings: ProjectPiSettings | undefined
) {
  const policy = readProjectPiPolicy(db, project.id);
  const actions = jsonStringArray(policy.allowed_supervisor_actions_json);
  const agent = supervisorProjectAgentStatus(db, settings);
  return {
    allowed_actions: actions,
    agent_runnable: agent.runnable,
    project_id: project.id,
    project_name: project.name,
    recovery_state: supervisorRecoveryState(policy.supervisor_mode, actions, agent.runnable),
    state_text: supervisorStateText(policy.supervisor_mode, actions, agent.runnable),
    supervisor_mode: policy.supervisor_mode
  };
}

function supervisorProjectAgentStatus(db: RunnerDatabase, settings: ProjectPiSettings | undefined) {
  const agentID = settings?.pi_agent_id ?? "";
  const agent = agentID ? getPiAgent(db, agentID) : listPiAgents(db).find((item) => item.enabled === 1);
  return { runnable: agent?.enabled === 1 };
}

function supervisorScanReason(automaticProjects: number, approvalProjects: number): string {
  if (automaticProjects > 0) return "已有项目允许 supervisor 自动恢复 allowlist 动作；仍只扫描故障恢复候选";
  if (approvalProjects > 0) return "Supervisor 可分析故障并生成待审批动作；当前不会自动续聊";
  return "Supervisor 只做故障恢复候选扫描；当前不会自动续聊，没有项目允许自动恢复";
}

function supervisorRecoveryState(mode: string, actions: string[], runnable: boolean): string {
  if (mode === "off") return "off";
  if (!runnable) return "needs_configuration";
  if (mode === "autonomous" && actions.length > 0) return "auto_recoverable";
  if (mode === "assisted") return "needs_approval";
  return "proposal_only";
}

function supervisorStateText(mode: string, actions: string[], runnable: boolean): string {
  if (mode === "off") return "已关闭，不会分析或续聊";
  if (!runnable) return "agent 不可执行，只能显示配置缺口";
  if (mode === "autonomous" && actions.length > 0) return "可自动恢复 allowlist 中的动作";
  if (mode === "autonomous") return "autonomous 已开启但 allowlist 为空，不会自动续聊";
  if (mode === "assisted") return "可分析故障并生成待审批恢复动作";
  return "只分析并提出建议，等待人工审批";
}

function jsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}
