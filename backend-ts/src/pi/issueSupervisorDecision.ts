import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../db/database.ts";
import { createIssueSupervisorEvent, type PiAgent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import { createPiRuntimeSession } from "../http/piRuntime.ts";
import type { PiGatePolicy } from "./actionGate.ts";
import {
  PI_SUPERVISOR_DECISION_JSON_SCHEMA,
  type PiSupervisorDecisionJson
} from "./issueSupervisorRecovery.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";

export type PiSupervisorDecisionRuntimeInput = {
  agent: PiAgent;
  context: IssueSupervisorRecoveryContext;
  database: RunnerDatabase;
  now?: Date;
  project: Project;
};

export type PiSupervisorDecisionRuntimeResult = {
  decision: PiSupervisorDecisionJson;
  error?: string;
  raw_text: string;
  valid: boolean;
};

const SUPERVISOR_TOOL_NAMES = [
  "issue_read",
  "issue_state_diagnose",
  "session_read_summary",
  "project_status",
  "memory_search",
  "memory_write_candidate",
  "grep",
  "find",
  "ls"
];

export async function runPiSupervisorDecision(
  input: PiSupervisorDecisionRuntimeInput
): Promise<PiSupervisorDecisionRuntimeResult> {
  const runtime = await createPiRuntimeSession(input.database, {
    agent: input.agent,
    authorization: supervisorAuthorization(input.project.id),
    conversationID: `pi-supervisor-${issueID(input.context)}-${Date.now()}`,
    issueID: issueID(input.context),
    heartbeatID: `pi-supervisor:${input.project.id}:${issueID(input.context)}`,
    project: input.project,
    source: "pi_supervisor_decision"
  });
  runtime.session.setActiveToolsByName(SUPERVISOR_TOOL_NAMES);
  try {
    await runtime.session.prompt(decisionPrompt(input.context, input.now ?? new Date()), {
      expandPromptTemplates: false,
      source: "pi_supervisor_decision"
    });
    const raw = runtime.session.getLastAssistantText() ?? "";
    const parsed = parseDecision(raw, input.context, input.now ?? new Date());
    if (!parsed.valid) {
      const fallback = fallbackDecision(input.context, parsed.error);
      recordDecisionFailure(input.database, input.context, raw, parsed.error, fallback);
      return { decision: fallback, error: parsed.error, raw_text: raw, valid: false };
    }
    recordDecisionSuccess(input.database, input.context, parsed.decision);
    return { decision: parsed.decision, raw_text: raw, valid: true };
  } finally {
    runtime.dispose();
  }
}

function decisionPrompt(context: IssueSupervisorRecoveryContext, now: Date): string {
  return [
    "You are PI Issue Supervisor. Decide how to recover, wait, escalate, or do nothing for one runner issue.",
    "Return exactly one JSON object. No markdown, no code fences, no prose outside JSON.",
    "Schema fields: decision, confidence, rationale, recovery_message, wait_until, risk_level, evidence_refs, expected_outcome, fallback_if_no_progress.",
    "Allowed decisions: wait, resume_session, steer_running_turn, retry_issue, needs_user, blocked, noop.",
    "Boundary constraints:",
    "- Check current issue/session/project state before recommending recovery.",
    "- Avoid duplicate operations and repeated recovery loops.",
    "- Respect provider retry-after windows; do not resume before a future wait_until.",
    "- 401/auth/permission/quota/business failures require needs_user or blocked, not automatic resume.",
    "- Do not bypass executor completion contract: executor must still verify, commit if required, and update issue final status.",
    "- Generate recovery_message from this context; do not use a fixed generic 'continue' template.",
    `Current time: ${now.toISOString()}`,
    "Supervisor context JSON:",
    JSON.stringify(context, null, 2)
  ].join("\n");
}

function parseDecision(
  raw: string,
  context: IssueSupervisorRecoveryContext,
  now: Date
): { decision: PiSupervisorDecisionJson; valid: true } | { error: string; valid: false } {
  const parsed = parseJsonObject(extractJson(raw));
  if (!parsed) return { error: "invalid supervisor decision JSON", valid: false };
  if (!Value.Check(PI_SUPERVISOR_DECISION_JSON_SCHEMA, parsed)) {
    return { error: "supervisor decision failed schema validation", valid: false };
  }
  const decision = parsed as PiSupervisorDecisionJson;
  const semanticError = semanticDecisionError(decision, context, now);
  return semanticError ? { error: semanticError, valid: false } : { decision, valid: true };
}

function extractJson(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function fallbackDecision(context: IssueSupervisorRecoveryContext, reason: string): PiSupervisorDecisionJson {
  return {
    confidence: "low",
    decision: issueID(context) > 0 ? "needs_user" : "noop",
    evidence_refs: ["supervisor_decision_invalid", ...candidateEvidence(context)],
    expected_outcome: "human reviews the invalid PI supervisor decision before any recovery action is dispatched",
    fallback_if_no_progress: "blocked",
    rationale: reason,
    recovery_message: "PI supervisor returned invalid decision JSON; human review is required before attempting recovery.",
    risk_level: "medium"
  };
}

function semanticDecisionError(
  decision: PiSupervisorDecisionJson,
  context: IssueSupervisorRecoveryContext,
  now: Date
): string {
  if (humanOnlyProviderFailure(context) && !["needs_user", "blocked"].includes(decision.decision)) {
    return "supervisor decision attempted automatic recovery for a human-only provider failure";
  }
  if (futureRetryAfter(context, now) && !["wait", "needs_user", "blocked", "noop"].includes(decision.decision)) {
    return "supervisor decision ignored a future provider retry-after window";
  }
  if (decision.decision === "wait" && cleanString(decision.wait_until) === "") {
    return "wait decision requires wait_until";
  }
  if ((decision.decision === "resume_session" || decision.decision === "steer_running_turn") &&
    cleanString(decision.recovery_message) === "") {
    return "session recovery decision requires recovery_message";
  }
  return "";
}

function recordDecisionSuccess(
  db: RunnerDatabase,
  context: IssueSupervisorRecoveryContext,
  decision: PiSupervisorDecisionJson
): void {
  createIssueSupervisorEvent(db, {
    confidence: decision.confidence,
    decision: decision.decision,
    diagnosis_code: primaryDiagnosis(context),
    event_type: "decision",
    issue_id: issueID(context),
    payload_json: { decision, valid: true },
    project_id: cleanString(context.project.id),
    provider: cleanString(context.session.provider) || cleanString(context.provider_error?.provider),
    provider_error_category: providerCategory(context),
    provider_session_id: cleanString(context.session.provider_session_id),
    provider_turn_id: cleanString(context.session.provider_turn_id),
    retry_after_at: cleanString(decision.wait_until) || cleanString(context.provider_error?.retry_after_at),
    run_id: cleanString(context.latest_run?.id)
  });
}

function recordDecisionFailure(
  db: RunnerDatabase,
  context: IssueSupervisorRecoveryContext,
  raw: string,
  error: string,
  fallback: PiSupervisorDecisionJson
): void {
  createIssueSupervisorEvent(db, {
    confidence: fallback.confidence,
    decision: fallback.decision,
    diagnosis_code: primaryDiagnosis(context),
    event_type: "decision_failed",
    issue_id: issueID(context),
    payload_json: {
      error,
      fallback_decision: fallback.decision,
      raw_text: truncate(raw),
      valid: false
    },
    project_id: cleanString(context.project.id),
    provider: cleanString(context.session.provider) || cleanString(context.provider_error?.provider),
    provider_error_category: providerCategory(context),
    provider_session_id: cleanString(context.session.provider_session_id),
    provider_turn_id: cleanString(context.session.provider_turn_id),
    retry_after_at: cleanString(context.provider_error?.retry_after_at),
    run_id: cleanString(context.latest_run?.id)
  });
}

function supervisorAuthorization(projectID: string): PiGatePolicy {
  const authorizedActions = SUPERVISOR_TOOL_NAMES.map((name) => ({
    action_type: name.startsWith("issue_")
      ? name.replace("issue_", "issue.")
      : name.startsWith("session_")
        ? name.replace("session_", "session.")
        : name.startsWith("memory_")
          ? name.replace("memory_", "memory.")
        : name === "project_status"
          ? "project.status"
          : `sdk.${name}`,
    project_id: projectID
  }));
  return {
    allowedActions: authorizedActions.map((action) => action.action_type),
    authorizedActions,
    mode: "delegated",
    scope: { project_id: projectID }
  };
}

function issueID(context: IssueSupervisorRecoveryContext): number {
  const value = context.issue.id;
  return typeof value === "number" ? value : Number(value) || 0;
}

function primaryDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return cleanString(context.candidates[0]?.diagnosis_code) || cleanString(context.provider_error?.diagnosis_code);
}

function providerCategory(context: IssueSupervisorRecoveryContext): string {
  return cleanString(context.provider_error?.category);
}

function humanOnlyProviderFailure(context: IssueSupervisorRecoveryContext): boolean {
  return ["auth", "permission", "quota", "business_failure"].includes(providerCategory(context));
}

function futureRetryAfter(context: IssueSupervisorRecoveryContext, now: Date): boolean {
  const retryAt = Date.parse(cleanString(context.provider_error?.retry_after_at));
  return Number.isFinite(retryAt) && retryAt > now.getTime();
}

function candidateEvidence(context: IssueSupervisorRecoveryContext): string[] {
  return context.candidates.flatMap((candidate) => candidate.evidence_refs ?? []).slice(0, 5);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 1_999)}…`;
}
