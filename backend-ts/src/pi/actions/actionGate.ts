import type { PiGateDecisionValue, PiWorkMode } from "./policyTypes.ts";
import { SUPERVISOR_CONTROL_HIGH_RISK_ACTION_TYPES, SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES, SUPERVISOR_CONTROL_READ_ACTION_TYPES } from "../supervisor/supervisorControlContracts.ts";
import { risk } from "./actionAuthorizationValues.ts";

export type PiRiskGate = "safe" | "confirm" | "high";

export type PiRiskLevel = "low" | "medium" | "high";

export type PiRiskClassification = {
  gate: PiRiskGate;
  requiresConfirmation: boolean;
  riskLevel: PiRiskLevel;
};

export type PiActionEnvelopeRisk = {
  gate: PiRiskGate | "forbidden";
  level: PiRiskLevel;
  requires_confirmation: boolean;
};

export type PiActionDecision = PiGateDecisionValue;

export type PiActionMode = PiWorkMode;

export type PiActionEnvelope = {
  action_type: string;
  delegation_id?: string;
  goal_id?: string;
  guardian_decision_id?: string;
  heartbeat_id?: string;
  idempotency_key?: string;
  issue_id?: number;
  payload: Record<string, unknown>;
  project_id?: string;
  rationale?: string;
  requires_confirmation: boolean;
  risk?: PiActionEnvelopeRisk;
  risk_gate?: PiRiskGate | "forbidden";
  risk_level: PiRiskClassification["riskLevel"];
  snoozed_until?: string;
  source: string;
};

export type PiAuthorizedAction = Partial<Pick<PiActionEnvelope,
  "action_type" | "delegation_id" | "goal_id" | "heartbeat_id" | "issue_id" | "project_id"
>> & { payload?: Record<string, unknown> };

export type PiGatePolicy = {
  allowedActions?: string[];
  allowed_actions?: string[];
  allowedMcpCapabilities?: string[];
  allowed_mcp_capabilities?: string[];
  allowedSkillIntents?: string[];
  allowed_skill_intents?: string[];
  authorizedActions?: PiAuthorizedAction[];
  askOnMissingAuthorization?: boolean;
  ask_on_missing_authorization?: boolean;
  expiresAt?: string;
  expires_at?: string;
  enforceAuthorizedReadScope?: boolean;
  forbiddenActions?: string[];
  forbidden_actions?: string[];
  mode?: PiActionMode;
  now?: Date | string;
  scope?: PiAuthorizationScope | PiAuthorizationScope[];
  scopes?: PiAuthorizationScope[];
  startsAt?: string;
  starts_at?: string;
};

export type PiGateDecision = { decision: PiActionDecision; reason: string };

export type PiAuthorizationScope = {
  delegation_id?: string;
  delegationId?: string;
  goal_id?: string;
  goalId?: string;
  heartbeat_id?: string;
  heartbeatId?: string;
  issue_id?: number | string;
  issueId?: number | string;
  issue_ids?: Array<number | string> | string;
  issueIds?: Array<number | string> | string;
  project_id?: string;
  projectId?: string;
  runner_resource?: string;
  runnerResource?: string;
};

export const PI_SAFE_ACTION_TYPES = [
  "skill.library_list", "skill.inspect_source", "skill.verify", "skill.use",
  "agent.catalog_list",
  "agent.profile_recommend",
  "human_review.request",
  "issue.comment", "issue.execution_status", "issue.list", "issue.read", "issue.retry_after", "issue.state_diagnose",
  "issue.status_summary",
  "issue_completion_watch.list",
  "issue.supervisor_decision", "project.list", "project.status",
  "runner.settings_read",
  "repo.read_excerpt", "repo.search", "repo.tree",
  "session.list", "session.read_summary", "memory.search", "memory.remember",
  "notification.preference.read",
  "run.interrupt",
  "sdk.read", "sdk.grep", "sdk.find", "sdk.ls",
  "skill.list", "skill.read", "skill.recommend", "skill.intent_audit",
  "skill.optional.call",
  "mcp.registry.list", "mcp.capability.read", "mcp.requirement.recommend", "mcp.resource.list", "mcp.resource.read",
  ...SUPERVISOR_CONTROL_READ_ACTION_TYPES
];

export const PI_READ_ONLY_ACTION_TYPES = [
  "skill.library_list", "skill.inspect_source", "skill.verify", "skill.use",
  "agent.catalog_list",
  "agent.profile_recommend",
  "issue.execution_status", "issue.list", "issue.read", "issue.state_diagnose", "issue.status_summary",
  "issue_completion_watch.list",
  "project.list", "project.status",
  "runner.settings_read",
  "repo.read_excerpt", "repo.search", "repo.tree",
  "session.list", "session.read_summary",
  "memory.search",
  "notification.preference.read",
  "sdk.read", "sdk.grep", "sdk.find", "sdk.ls",
  "skill.list", "skill.read", "skill.recommend",
  "skill.optional.call",
  "mcp.registry.list", "mcp.capability.read", "mcp.requirement.recommend", "mcp.resource.list", "mcp.resource.read",
  ...SUPERVISOR_CONTROL_READ_ACTION_TYPES
];

export const SAFE_ACTIONS = new Set(PI_SAFE_ACTION_TYPES);

export const SUPERVISOR_HIGH_RISK_ACTIONS = new Set<string>(SUPERVISOR_CONTROL_HIGH_RISK_ACTION_TYPES);

export const CONFIRM_ACTIONS = new Set([
  "agent.executor_assign", "agent.workflow_request", "human_review.respond", "issue.cancel", "issue.create", "issue.enqueue", "issue.schedule_enqueue",
  "issue.status_update",
  "project.create", "workspace.make_directory", "workspace.write_file",
  "issue.acceptance_request",
  "issue_completion_watch.create", "issue_completion_watch.cancel",
  "notification.preference.update",
  "issue.retry", "issue.state_repair", "needs_user.escalate",
  "session.resume_followup",
  ...SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES.filter((action) => !SUPERVISOR_HIGH_RISK_ACTIONS.has(action))
]);

export const HIGH_RISK_ACTIONS = new Set([
  "assistant.tool.call",
  "issue.delete",
  "mcp.tool.call",
  "runner.settings_update",
  "session.steer",
  "system.restart",
  ...SUPERVISOR_CONTROL_HIGH_RISK_ACTION_TYPES
]);

export const READ_ONLY_ACTIONS = new Set(PI_READ_ONLY_ACTION_TYPES);

export { classifyPiActionRisk, gatePiActionEnvelope, decidePiAuthorization } from "./actionAuthorization.ts";
