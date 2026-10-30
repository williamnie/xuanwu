import type { RunnerDatabase } from "../../db/database.ts";
import { type PiAgent } from "../../db/repositories/pi.ts";
import type { Project } from "../../db/repositories/projects.ts";
import { piInternalReadAuthorization } from "../actions/internalReadAuthorization.ts";
import { withOptionalJevTool } from "../../skills/jev/policy.ts";
import { RUN_MEMORY_RULES } from "../memory/runMemoryContext.ts";
import { type PiSupervisorDecisionJson } from "./issueSupervisorRecovery.ts";
import { decisionFailure } from "./issueSupervisorDecisionFailure.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { appLanguage, type AppLanguage } from "../../i18n/language.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { parseStructuredAssistantOutput, structuredAssistantProviderError } from "../runtime/structuredAssistantOutput.ts";
import { cleanString } from "../../util/values.ts";
import { issueID, parseDecision, fallbackDecision, recordDecisionFailure, recordDecisionSuccess } from "./issueSupervisorDecisionResult.ts";

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

export const SUPERVISOR_TOOL_NAMES = [
  "issue_read",
  "issue_state_diagnose",
  "session_read_summary",
  "project_status",
  "memory_search",
  "grep",
  "find",
  "ls"
];

export const SUPERVISOR_PROMPT_TIMEOUT_MS = 75_000;

export async function runPiSupervisorDecision(
  input: PiSupervisorDecisionRuntimeInput
): Promise<PiSupervisorDecisionRuntimeResult> {
  const language = appLanguage(input.database);
  const { createPiRuntimeSession } = await import("../../http/pi/piRuntime.ts");
  const toolNames = withOptionalJevTool(input.database, { projectID: input.project.id, issueID: issueID(input.context), source: "pi_supervisor_decision" }, SUPERVISOR_TOOL_NAMES);
  const runtime = await createPiRuntimeSession(input.database, {
    agent: input.agent,
    authorization: piInternalReadAuthorization({
      issueID: issueID(input.context),
      projectID: input.project.id,
      toolNames
    }),
    conversationID: `pi-supervisor-${issueID(input.context)}-${Date.now()}`,
    issueID: issueID(input.context),
    issueRunID: cleanString(input.context.latest_run?.id),
    heartbeatID: `pi-supervisor:${input.project.id}:${issueID(input.context)}`,
    promptProfile: "recovery",
    project: input.project,
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    source: "pi_supervisor_decision"
  });
  runtime.session.setActiveToolsByName(toolNames);
  try {
    await promptSupervisorWithTimeout(runtime.session, decisionPrompt(input.context, input.now ?? new Date(), language));
    const output = parseStructuredAssistantOutput(runtime.session, (raw) => {
      const candidate = parseDecision(raw, input.context, input.now ?? new Date());
      return candidate.valid ? candidate.decision : null;
    });
    const raw = output.raw;
    const providerError = structuredAssistantProviderError(runtime.session);
    const parsed = providerError === ""
      ? parseDecision(raw, input.context, input.now ?? new Date())
      : decisionFailure(`Supervisor provider failed: ${redactSensitiveText(providerError)}`);
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

export async function promptSupervisorWithTimeout(
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

export function decisionPrompt(context: IssueSupervisorRecoveryContext, now: Date, language: AppLanguage): string {
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
    RUN_MEMORY_RULES,
    "Use durable_context.run_memory for this Run's frozen snapshot and Host applicability recheck. Independently check current code/version, every applies_when condition and counterexample before citing or proposing reuse; do not treat the Host text filter as semantic approval.",
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
