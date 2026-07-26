import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../db/database.ts";
import { createIssueSupervisorEvent, type PiAgent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { PiGatePolicy } from "./actionGate.ts";
import {
  PI_SUPERVISOR_DECISION_JSON_SCHEMA,
  type PiSupervisorDecisionJson
} from "./issueSupervisorRecovery.ts";
import {
  decisionFailure,
  decisionFailurePayload,
  schemaDecisionFailure,
  type DecisionFailure
} from "./issueSupervisorDecisionFailure.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import {
  isAutomaticRecoveryBlockedDiagnosis,
  isTransientRecoveryDiagnosis
} from "./recoveryDiagnosis.ts";

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
  error_summary?: string;
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

const HARD_OUTAGE_DIAGNOSES = new Set(["session_recovery_exhausted", "recovery_budget_exhausted"]);
const SUPERVISOR_PROMPT_TIMEOUT_MS = 75_000;

export async function runPiSupervisorDecision(
  input: PiSupervisorDecisionRuntimeInput
): Promise<PiSupervisorDecisionRuntimeResult> {
  const { createPiRuntimeSession } = await import("../http/piRuntime.ts");
  const runtime = await createPiRuntimeSession(input.database, {
    agent: input.agent,
    authorization: supervisorAuthorization(input.project.id),
    conversationID: `pi-supervisor-${issueID(input.context)}-${Date.now()}`,
    issueID: issueID(input.context),
    heartbeatID: `pi-supervisor:${input.project.id}:${issueID(input.context)}`,
    project: input.project,
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    source: "pi_supervisor_decision"
  });
  runtime.session.setActiveToolsByName(SUPERVISOR_TOOL_NAMES);
  try {
    await promptSupervisorWithTimeout(runtime.session, decisionPrompt(input.context, input.now ?? new Date()));
    const raw = runtime.session.getLastAssistantText() ?? "";
    const parsed = parseDecision(raw, input.context, input.now ?? new Date());
    if (!parsed.valid) {
      const fallback = fallbackDecision(input.context, parsed.error);
      recordDecisionFailure(input.database, input.context, raw, parsed, fallback);
      return {
        decision: fallback,
        error: parsed.error,
        error_summary: parsed.error_summary,
        raw_text: raw,
        valid: false
      };
    }
    recordDecisionSuccess(input.database, input.context, parsed.decision);
    return { decision: parsed.decision, raw_text: raw, valid: true };
  } finally {
    runtime.dispose();
  }
}

async function promptSupervisorWithTimeout(
  session: {
    abort(): Promise<void>;
    prompt(prompt: string, options: { expandPromptTemplates: boolean; source: "rpc" }): Promise<void>;
  },
  prompt: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`PI Supervisor prompt timed out after ${SUPERVISOR_PROMPT_TIMEOUT_MS}ms`));
      void session.abort().catch(() => undefined);
    }, SUPERVISOR_PROMPT_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" }),
      timeout
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function decisionPrompt(context: IssueSupervisorRecoveryContext, now: Date): string {
  return [
    "You are the Xuanwu Supervisor. Decide how to recover, wait, escalate, or do nothing for one Runner issue.",
    "Return exactly one JSON object. No markdown, no code fences, no prose outside JSON.",
    "Schema fields: decision, confidence, rationale, recovery_message, wait_until, risk_level, evidence_refs, expected_outcome, fallback_if_no_progress.",
    "Allowed decisions: wait, resume_session, steer_running_turn, retry_issue, needs_user, blocked, noop.",
    "Allowed confidence and risk_level values: low, medium, high. Do not return numeric confidence.",
    "Allowed fallback_if_no_progress values: needs_user, retry_issue, blocked. Do not put explanatory prose in this field.",
    "Omit optional recovery_message or wait_until when unused; never return null.",
    "Boundary constraints:",
    "- Supervisor owns issue lifecycle; Codex/Claude are executor workers in a generic worker/provider model.",
    "- Check current issue/session/project state before recommending recovery.",
    "- Avoid duplicate operations and repeated recovery loops.",
    "- Respect provider retry-after windows; do not resume before a future wait_until.",
    "- 401/auth/permission/quota/business failures require needs_user or blocked, not automatic resume.",
    "- Provider timeouts, transport failures, session_no_recent_progress, and provider_runtime_unavailable are transient while recovery budget remains: respect retry-after, wait, resume a live session, or retry the issue on a fresh provider process.",
    "- A missing provider session cannot be resumed; choose retry_issue after any retry-after window instead.",
    "- Only auth/permission/quota/business failures or session/recovery budget exhaustion may choose needs_user or blocked.",
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
): { decision: PiSupervisorDecisionJson; valid: true } | DecisionFailure {
  const parsed = parseJsonObject(extractJson(raw));
  if (!parsed) return decisionFailure("invalid supervisor decision JSON");
  const normalized = normalizeDecisionObject(parsed);
  if (!Value.Check(PI_SUPERVISOR_DECISION_JSON_SCHEMA, normalized)) {
    return schemaDecisionFailure(normalized);
  }
  const decision = normalized as PiSupervisorDecisionJson;
  const semanticError = semanticDecisionError(decision, context, now);
  return semanticError ? decisionFailure(semanticError) : { decision, valid: true };
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

function normalizeDecisionObject(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  if (typeof normalized.confidence === "number" && Number.isFinite(normalized.confidence)) {
    const confidence = normalized.confidence > 1 ? normalized.confidence / 100 : normalized.confidence;
    normalized.confidence = confidence >= 0.75 ? "high" : confidence >= 0.4 ? "medium" : "low";
  }
  for (const key of ["recovery_message", "wait_until"] as const) {
    if (normalized[key] === null) delete normalized[key];
  }
  const fallback = cleanString(normalized.fallback_if_no_progress);
  if (!["needs_user", "retry_issue", "blocked"].includes(fallback)) {
    normalized.fallback_if_no_progress = normalizeFallback(fallback);
  }
  return normalized;
}

function normalizeFallback(value: string): "needs_user" | "retry_issue" | "blocked" {
  const text = value.toLowerCase();
  if (/(blocked?|stop|do not (?:repeat|retry|resume)|保持.*(?:阻塞|失败)|停止)/i.test(text)) return "blocked";
  if (/(needs?_user|human|user|manual|ask|escalat|人工|用户|求助)/i.test(text)) return "needs_user";
  if (/(retry|resume|recover|continue|重试|恢复|继续)/i.test(text)) return "retry_issue";
  return "blocked";
}

function fallbackDecision(context: IssueSupervisorRecoveryContext, reason: string): PiSupervisorDecisionJson {
  return {
    confidence: "low",
    decision: "noop",
    evidence_refs: ["supervisor_decision_invalid", ...candidateEvidence(context)],
    expected_outcome: "Supervisor retries its decision after cooldown without mutating the Issue or Run",
    fallback_if_no_progress: "blocked",
    rationale: reason,
    recovery_message: "Xuanwu Supervisor returned an invalid decision; keep current state unchanged and retry the decision after cooldown.",
    risk_level: "medium"
  };
}

function semanticDecisionError(
  decision: PiSupervisorDecisionJson,
  context: IssueSupervisorRecoveryContext,
  now: Date
): string {
  const decisionType = cleanString(decision.decision);
  const blockedReason = deterministicNeedsUserReason(context);
  if (blockedReason && !["needs_user", "blocked"].includes(decisionType)) {
    return blockedReason;
  }
  if (futureRetryAfter(context, now) && !["wait", "needs_user", "blocked", "noop"].includes(decisionType)) {
    return "supervisor decision ignored a future provider retry-after window";
  }
  if ((decisionType === "resume_session" || decisionType === "steer_running_turn") &&
    cleanString(context.session.provider_session_id) === "") {
    return "session recovery decision requires an existing provider session; retry_issue is required for a fresh provider process";
  }
  if (isTransientRecoveryDiagnosis(primaryDiagnosis(context)) &&
    ["needs_user", "blocked"].includes(decisionType) &&
    !hardOutageDiagnosis(context)) {
    return "transient provider/session diagnosis must use wait, resume_session, retry_issue, or noop while recovery budget remains";
  }
  if (decisionType === "wait" && cleanString(decision.wait_until) === "") {
    return "wait decision requires wait_until";
  }
  if ((decisionType === "resume_session" || decisionType === "steer_running_turn") &&
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
  failure: DecisionFailure,
  fallback: PiSupervisorDecisionJson
): void {
  createIssueSupervisorEvent(db, {
    confidence: fallback.confidence,
    decision: fallback.decision,
    diagnosis_code: primaryDiagnosis(context),
    event_type: "decision_failed",
    issue_id: issueID(context),
    payload_json: decisionFailurePayload({ context, failure, fallback, raw }),
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

function deterministicNeedsUserReason(context: IssueSupervisorRecoveryContext): string {
  const hardOutage = hardOutageDiagnosis(context);
  if (hardOutage) {
    return `supervisor decision attempted automatic recovery for provider runtime unavailable or exhausted recovery diagnosis (${hardOutage}); Supervisor must choose needs_user or blocked`;
  }
  if (isAutomaticRecoveryBlockedDiagnosis(primaryDiagnosis(context)) ||
    ["auth", "permission", "quota", "business_failure"].includes(providerCategory(context))) {
    return "supervisor decision attempted automatic recovery for a deterministic needs_context diagnosis or human-only provider failure";
  }
  return "";
}

function hardOutageDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return allDiagnosisCodes(context).find((code) => HARD_OUTAGE_DIAGNOSES.has(code)) ?? "";
}

function allDiagnosisCodes(context: IssueSupervisorRecoveryContext): string[] {
  return [
    ...context.candidates.map((candidate) => cleanString(candidate.diagnosis_code)),
    cleanString(context.provider_error?.diagnosis_code)
  ].filter((code) => code !== "");
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
