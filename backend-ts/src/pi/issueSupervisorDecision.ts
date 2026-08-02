import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../db/database.ts";
import { createIssueSupervisorEvent, type PiAgent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import { piInternalReadAuthorization } from "./internalReadAuthorization.ts";
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
import { appLanguage, type AppLanguage } from "../i18n/language.ts";

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
  "grep",
  "find",
  "ls"
];

const SUPERVISOR_PROMPT_TIMEOUT_MS = 75_000;

export async function runPiSupervisorDecision(
  input: PiSupervisorDecisionRuntimeInput
): Promise<PiSupervisorDecisionRuntimeResult> {
  const language = appLanguage(input.database);
  const { createPiRuntimeSession } = await import("../http/piRuntime.ts");
  const runtime = await createPiRuntimeSession(input.database, {
    agent: input.agent,
    authorization: piInternalReadAuthorization({
      issueID: issueID(input.context),
      projectID: input.project.id,
      toolNames: SUPERVISOR_TOOL_NAMES
    }),
    conversationID: `pi-supervisor-${issueID(input.context)}-${Date.now()}`,
    issueID: issueID(input.context),
    heartbeatID: `pi-supervisor:${input.project.id}:${issueID(input.context)}`,
    promptProfile: "recovery",
    project: input.project,
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    source: "pi_supervisor_decision"
  });
  runtime.session.setActiveToolsByName(SUPERVISOR_TOOL_NAMES);
  try {
    await promptSupervisorWithTimeout(runtime.session, decisionPrompt(input.context, input.now ?? new Date(), language));
    const raw = runtime.session.getLastAssistantText() ?? "";
    const parsed = parseDecision(raw, input.context, input.now ?? new Date());
    if (!parsed.valid) {
      const fallback = fallbackDecision(input.context, parsed.error, language);
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
      reject(new Error(`Xuanwu Supervisor prompt timed out after ${SUPERVISOR_PROMPT_TIMEOUT_MS}ms`));
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

function decisionPrompt(context: IssueSupervisorRecoveryContext, now: Date, language: AppLanguage): string {
  return [
    "You are the Xuanwu PI deciding how to recover, wait, escalate, or do nothing for one Runner Issue. The Supervisor only detected and delivered this signal; it has no semantic Issue authority.",
    "Return exactly one JSON object. No markdown, no code fences, no prose outside JSON.",
    language === "zh-CN"
      ? "所有自然语言文本字段（rationale、recovery_message、expected_outcome）必须使用简体中文；schema key 和枚举值保持英文。"
      : "All natural-language text fields (rationale, recovery_message, expected_outcome) must be in English; keep schema keys and enum values in English.",
    "Schema fields: decision, confidence, rationale, recovery_message, wait_until, repair_diagnosis_code, repair_operation, risk_level, evidence_refs, expected_outcome, fallback_if_no_progress.",
    "Allowed decisions: wait, resume_session, steer_running_turn, retry_issue, repair_issue_state, needs_user, blocked, noop.",
    "Allowed confidence and risk_level values: low, medium, high. Do not return numeric confidence.",
    "Allowed fallback_if_no_progress values: needs_user, retry_issue, blocked. Do not put explanatory prose in this field.",
    "Omit optional recovery_message or wait_until when unused; never return null.",
    "Boundary constraints:",
    "- PI owns semantic Issue lifecycle decisions. The Host performs authorized writes; Codex/Claude are Provider workers; Supervisor only detects and signals.",
    "- Check current issue/session/project state before recommending recovery.",
    "- Avoid duplicate operations and repeated recovery loops.",
    "- Respect provider retry-after windows; do not resume before a future wait_until.",
    "- Diagnose from the supplied runtime facts and actual Session context. Classification hints are observations, not mandatory action mappings.",
    "- 401/auth/permission/quota/business failures usually require needs_user or blocked, but explain the evidence behind the decision.",
    "- Provider timeouts, transport failures, session_no_recent_progress, and provider_runtime_unavailable may be recoverable. Choose wait, resume, retry, needs_user, blocked, or noop from the actual evidence and remaining budget.",
    "- A missing provider session cannot be resumed; choose retry_issue after any retry-after window instead.",
    "- Choose repair_issue_state only for a current state_diagnostics recommended action, and copy its code to repair_diagnosis_code and operation to repair_operation.",
    "- You may choose needs_user or blocked whenever the evidence shows automatic recovery is impossible, unsafe, repeatedly failing, or requires user configuration/input.",
    "- Provider prose never updates the final Issue status. After any resumed Turn ends, PI must read the Session again and make the semantic decision; the Host writes it.",
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
  for (const key of ["recovery_message", "wait_until", "repair_diagnosis_code", "repair_operation"] as const) {
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

function fallbackDecision(context: IssueSupervisorRecoveryContext, reason: string, language: AppLanguage): PiSupervisorDecisionJson {
  const chinese = language === "zh-CN";
  return {
    confidence: "low",
    decision: "noop",
    evidence_refs: ["supervisor_decision_invalid", ...candidateEvidence(context)],
    expected_outcome: chinese ? "Supervisor 在冷却后重试决策，且不修改 Issue 或 Run" : "Supervisor retries its decision after cooldown without mutating the Issue or Run",
    fallback_if_no_progress: "blocked",
    rationale: reason,
    recovery_message: chinese ? "玄武 Supervisor 返回了无效决策；保持当前状态不变，并在冷却后重试决策。" : "Xuanwu Supervisor returned an invalid decision; keep current state unchanged and retry the decision after cooldown.",
    risk_level: "medium"
  };
}

function semanticDecisionError(
  decision: PiSupervisorDecisionJson,
  context: IssueSupervisorRecoveryContext,
  now: Date
): string {
  const decisionType = cleanString(decision.decision);
  if (futureRetryAfter(context, now) && !["wait", "needs_user", "blocked", "noop"].includes(decisionType)) {
    return "supervisor decision ignored a future provider retry-after window";
  }
  if ((decisionType === "resume_session" || decisionType === "steer_running_turn") &&
    cleanString(context.session.provider_session_id) === "") {
    return "session recovery decision requires an existing provider session; retry_issue is required for a fresh provider process";
  }
  if (decisionType === "repair_issue_state" && !matchingStateRepair(context, decision)) {
    return "repair_issue_state requires a current state_diagnostics recommended action";
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

function matchingStateRepair(
  context: IssueSupervisorRecoveryContext,
  decision: PiSupervisorDecisionJson
): boolean {
  const diagnosisCode = cleanString(decision.repair_diagnosis_code);
  const operation = cleanString(decision.repair_operation);
  if (diagnosisCode === "" || operation === "") return false;
  return (context.state_diagnostics ?? []).some((diagnostic) =>
    diagnostic.code === diagnosisCode &&
    diagnostic.recommended_actions.some((action) => action.operation === operation)
  );
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
