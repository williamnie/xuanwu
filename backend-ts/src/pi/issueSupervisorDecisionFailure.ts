import { Value } from "@sinclair/typebox/value";
import {
  PI_SUPERVISOR_DECISION_JSON_SCHEMA,
  type PiSupervisorDecisionJson
} from "./issueSupervisorRecovery.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";

export type DecisionFailure = {
  error: string;
  error_summary: string;
  schema_errors?: Array<{ message: string; path: string }>;
  valid: false;
};

const MAX_RAW_TEXT_CHARS = 2_000;
const MAX_SCHEMA_ERRORS = 8;

export function decisionFailure(
  error: string,
  schema_errors: Array<{ message: string; path: string }> = []
): DecisionFailure {
  return {
    error,
    error_summary: errorSummary(error, schema_errors),
    ...(schema_errors.length > 0 ? { schema_errors } : {}),
    valid: false
  };
}

export function schemaDecisionFailure(parsed: Record<string, unknown>): DecisionFailure {
  return decisionFailure(
    "supervisor decision failed schema validation",
    [...Value.Errors(PI_SUPERVISOR_DECISION_JSON_SCHEMA, parsed)]
      .slice(0, MAX_SCHEMA_ERRORS)
      .map((error) => ({
        message: String(error.message ?? "").trim() || "schema mismatch",
        path: String(error.path ?? "").trim() || "/"
      }))
  );
}

export function decisionFailurePayload(input: {
  context: IssueSupervisorRecoveryContext;
  failure: DecisionFailure;
  fallback: PiSupervisorDecisionJson;
  raw: string;
}): Record<string, unknown> {
  return {
    context: diagnosticContext(input.context),
    error: input.failure.error,
    error_summary: input.failure.error_summary,
    fallback_decision: input.fallback.decision,
    raw_text: truncatedRawText(input.raw),
    raw_text_truncated: isTruncated(input.raw),
    schema_errors: input.failure.schema_errors ?? [],
    valid: false
  };
}

function errorSummary(error: string, schema_errors: Array<{ message: string; path: string }>): string {
  if (schema_errors.length === 0) return error;
  const fields = schema_errors.map((item) => `${item.path}: ${item.message}`).join("; ");
  return `${error}: ${fields}`;
}

function diagnosticContext(context: IssueSupervisorRecoveryContext): Record<string, unknown> {
  return {
    context_id: supervisorContextID(context),
    issue_id: issueID(context),
    project_id: cleanString(context.project.id),
    provider_session_id: cleanString(context.session.provider_session_id),
    provider_turn_id: cleanString(context.session.provider_turn_id),
    run_id: cleanString(context.latest_run?.id)
  };
}

function supervisorContextID(context: IssueSupervisorRecoveryContext): string {
  return [
    cleanString(context.project.id),
    String(issueID(context)),
    cleanString(context.latest_run?.id) || cleanString(context.session.provider_session_id)
  ].filter(Boolean).join(":");
}

function issueID(context: IssueSupervisorRecoveryContext): number {
  const value = context.issue.id;
  return typeof value === "number" ? value : Number(value) || 0;
}

function truncatedRawText(value: string): string {
  return isTruncated(value) ? `${value.slice(0, MAX_RAW_TEXT_CHARS - 1)}…` : value;
}

function isTruncated(value: string): boolean {
  return value.length > MAX_RAW_TEXT_CHARS;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
