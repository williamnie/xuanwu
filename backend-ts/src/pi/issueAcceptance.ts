import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../db/database.ts";
import type { PiAgent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { CompletionCard } from "../domain/acceptance/completionCard.ts";
import { appLanguage } from "../i18n/language.ts";
import type { PiGatePolicy } from "./actionGate.ts";

export const PI_ACCEPTANCE_DECISIONS = [
  "accept",
  "continue_same_session",
  "retry",
  "needs_user",
  "failed"
] as const;

export const PI_ACCEPTANCE_DECISION_SCHEMA = Type.Object({
  decision: Type.Union(PI_ACCEPTANCE_DECISIONS.map((value) => Type.Literal(value))),
  confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  rationale: Type.String({ minLength: 1, maxLength: 8_000 }),
  evidence_refs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
  unmet_requirements: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 32 }),
  follow_up_prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 }))
}, { additionalProperties: false });

export type PiAcceptanceDecision = Static<typeof PI_ACCEPTANCE_DECISION_SCHEMA>;

export type PiAcceptanceRuntimeResult =
  | {
    decision: PiAcceptanceDecision;
    raw_text: string;
    valid: true;
  }
  | {
    error: string;
    raw_text: string;
    valid: false;
  };

const ACCEPTANCE_TOOL_NAMES = [
  "issue_read",
  "session_read_summary",
  "repo_search",
  "repo_read_excerpt",
  "repo_tree",
  "grep",
  "find",
  "ls"
];
const ACCEPTANCE_TIMEOUT_MS = 75_000;

export async function runPiIssueAcceptance(input: {
  agent: PiAgent;
  card: CompletionCard;
  database: RunnerDatabase;
  project: Project;
}): Promise<PiAcceptanceRuntimeResult> {
  const { createPiRuntimeSession } = await import("../http/piRuntime.ts");
  const runtime = await createPiRuntimeSession(input.database, {
    agent: input.agent,
    authorization: acceptanceAuthorization(input.project.id, input.card.issue.id),
    conversationID: `pi-acceptance-${input.card.issue.id}-${input.card.fingerprint.slice(0, 12)}`,
    issueID: input.card.issue.id,
    heartbeatID: `pi-acceptance:${input.project.id}:${input.card.issue.id}:${input.card.fingerprint.slice(0, 12)}`,
    promptProfile: "acceptance",
    project: input.project,
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    source: "pi_issue_acceptance"
  });
  runtime.session.setActiveToolsByName(ACCEPTANCE_TOOL_NAMES);
  try {
    await promptWithTimeout(runtime.session, acceptancePrompt(input.card, appLanguage(input.database)));
    const raw = runtime.session.getLastAssistantText() ?? "";
    const decision = parseAcceptanceDecision(raw);
    if (decision) return { decision, raw_text: raw, valid: true };
    return {
      error: "PI acceptance returned invalid JSON or schema",
      raw_text: raw,
      valid: false
    };
  } finally {
    runtime.dispose();
  }
}

export function parseAcceptanceDecision(raw: string): PiAcceptanceDecision | null {
  const text = extractJson(raw);
  try {
    const parsed = JSON.parse(text) as unknown;
    return Value.Check(PI_ACCEPTANCE_DECISION_SCHEMA, parsed)
      ? parsed as PiAcceptanceDecision
      : null;
  } catch {
    return null;
  }
}

function acceptancePrompt(card: CompletionCard, language: string): string {
  return [
    "You are the Xuanwu PI accepting one completed Work on the user's behalf.",
    "This is a semantic acceptance decision, not a shell-command classifier and not a project manager meeting.",
    "Return exactly one JSON object. No markdown, code fences, or prose outside JSON.",
    language === "zh-CN"
      ? "rationale、unmet_requirements、follow_up_prompt 使用简体中文；schema key 和 decision 枚举保持英文。"
      : "Use English for natural-language fields; keep schema keys and decision enums unchanged.",
    "Required fields: decision, confidence, rationale, evidence_refs, unmet_requirements. follow_up_prompt is optional.",
    `decision MUST be exactly one string literal from: ${PI_ACCEPTANCE_DECISIONS.join(", ")}.`,
    "confidence MUST be exactly one string literal: low, medium, or high. Never output a number, probability, percentage, or any other confidence form.",
    "The exact JSON shape is: {\"decision\":\"accept|continue_same_session|retry|needs_user|failed\",\"confidence\":\"low|medium|high\",\"rationale\":\"...\",\"evidence_refs\":[\"...\"],\"unmet_requirements\":[\"...\"],\"follow_up_prompt\":\"optional...\"}.",
    "Judge whether the chronological facts satisfy the authoritative Issue goal and acceptance criteria.",
    "Commands are observations, not pre-classified proof. Read their command, exit_code, order, output excerpt, changed files, commits, final message, and warnings together.",
    "The session field is a live bounded read of the Provider Session. If latest_turn_matches_run is false, treat latest_turn_items and session.current_git as later facts that supersede a stale canonical Run card when they clearly belong to this Issue.",
    "When human_review is present, its explicit response is authoritative only for the stated product, scope, risk, cost, or external-verification choice. Judge the current workspace together with origin_completion and intervening_runs. An intentionally interrupted mistaken retry is not by itself an implementation failure and must not cause another retry or Provider Session.",
    "An earlier failed command may be superseded by a later successful command only when the later command actually covers the relevant scope. Explain that relationship rather than treating the latest row mechanically.",
    "The executor final message is a claim that may help correlate facts, but it is not sufficient by itself.",
    "Do not require test/lint/build for every task. Require evidence appropriate to this Issue's actual requested outcome and risk.",
    "Choose accept when the bounded facts are sufficient. Every normal completed Work must receive this PI judgment; do not defer merely because deterministic code did not label a command.",
    "Choose continue_same_session when the same executor should fix a concrete defect or produce missing proof; include an actionable follow_up_prompt.",
    "Use the available read-only repository and Session tools before deciding; code review and independent checks are PI work, not separate lifecycle states.",
    "Choose retry only when the existing Provider Session cannot responsibly continue and a fresh Session is required; include an actionable follow_up_prompt.",
    "Choose needs_user only for a concrete product, scope, authorization, destructive-risk, visual, release, cost, or external-state decision that the system cannot responsibly make.",
    "Choose failed only when the Issue is conclusively unrecoverable within its authorized scope. A Provider error, disconnect, missing command, or exhausted automatic-recovery counter is not by itself grounds for failed.",
    "Never create another Issue, never ask for a generic verifier, and never retry the same unchanged diagnosis.",
    "evidence_refs must reference concrete card facts such as command:<id>, git:<revision>, run:<id>, session:<turn-id>, or final_message.",
    "Completion card JSON:",
    JSON.stringify(card, null, 2)
  ].join("\n");
}

async function promptWithTimeout(
  session: {
    abort(): Promise<void>;
    prompt(prompt: string, options: { expandPromptTemplates: boolean; source: "rpc" }): Promise<void>;
  },
  prompt: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Xuanwu PI acceptance timed out after ${ACCEPTANCE_TIMEOUT_MS}ms`));
      void session.abort().catch(() => undefined);
    }, ACCEPTANCE_TIMEOUT_MS);
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

function acceptanceAuthorization(projectID: string, issueID: number): PiGatePolicy {
  const authorizedActions = ACCEPTANCE_TOOL_NAMES.map((name) => ({
    action_type: name.startsWith("issue_")
      ? name.replace("issue_", "issue.")
      : name.startsWith("session_")
        ? name.replace("session_", "session.")
        : name.startsWith("repo_")
          ? name.replace("repo_", "repo.")
          : `sdk.${name}`,
    issue_id: issueID,
    project_id: projectID
  }));
  return {
    allowedActions: authorizedActions.map((action) => action.action_type),
    authorizedActions,
    mode: "delegated",
    scope: { issue_id: issueID, project_id: projectID }
  };
}

function extractJson(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}
