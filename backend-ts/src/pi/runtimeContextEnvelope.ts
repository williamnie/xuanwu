import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import type { RuntimeSessionInput } from "../http/piRuntime.ts";
import { retrievePiMemoryContext } from "./memoryContext.ts";

export const PI_RUNTIME_CONTEXT_SCHEMA_VERSION = "xw.pi-runtime-context.v1" as const;

export type PiRuntimeContextEnvelope = ReturnType<typeof buildPiRuntimeContextEnvelope>;

export function buildPiRuntimeContextEnvelope(db: RunnerDatabase, input: RuntimeSessionInput) {
  const project = input.toolProject ?? input.project;
  const memory = retrievePiMemoryContext(db, {
    conversationID: input.conversationID,
    issueID: input.issueID,
    projectID: project?.id,
    sourceID: input.source || input.sourceTurn?.source
  });
  return {
    schema_version: PI_RUNTIME_CONTEXT_SCHEMA_VERSION,
    identity: {
      agent_id: input.agent.id,
      agent_name: input.agent.name,
      logical_role: "xuanwu_pi"
    },
    invocation: {
      conversation_id: input.conversationID,
      profile: input.promptProfile,
      source: cleanString(input.source),
      source_turn_id: cleanString(input.sourceTurn?.id)
    },
    target: {
      binding: runtimeTargetBinding(input, Boolean(project?.id)),
      issue_id: positiveInteger(input.issueID),
      project_id: cleanString(project?.id)
    },
    durable_context: {
      memory_items: memory.memory_items.map((item) => ({
        authority: item.authority,
        confidence: item.confidence,
        content: item.content,
        kind: item.kind,
        memory_key: item.memory_key,
        reference: item.reference,
        retrieval_scope: item.retrieval_scope,
        updated_at: item.updated_at
      })),
      retrieval_scopes: memory.retrieval_scopes,
      truncation: memory.truncation_summary
    },
    authority_rules: [
      "user_explicit memory is binding only for the exact stored preference, workflow, constraint, or acceptance choice in scope",
      "evidence_backed memory is reusable technical evidence and must still be checked against current facts",
      "advisory memory is a hint only",
      "current Work, Run, Issue, Provider Session, approval, permission, and repository state must come from authoritative runtime records or tools",
      "the explicit issue target for this invocation must never be replaced by unrelated conversation history"
    ]
  };
}

function runtimeTargetBinding(input: RuntimeSessionInput, hasProject: boolean): string {
  const binding = input.supervisorContext?.provenance.target_binding;
  const hasIssue = positiveInteger(input.issueID) > 0 || (input.supervisorContext?.target.issue_ids.length ?? 0) > 0;
  if (binding === "one_shot") return hasIssue ? "one_shot_issue" : "one_shot_project";
  if (binding === "conversation") return hasIssue ? "conversation_issue" : "conversation_project";
  if (binding === "explicit" || positiveInteger(input.issueID) > 0) return hasIssue ? "explicit_issue" : "explicit_project";
  return hasProject ? "runtime_project" : "conversation_only";
}

export function piRuntimeContextEnvelopePrompt(envelope: PiRuntimeContextEnvelope): string {
  return [
    "Shared PI runtime context envelope (one logical PI identity; profile-scoped execution):",
    JSON.stringify(envelope),
    "Apply only the projection relevant to this profile. This envelope shares durable user policy and exact target identity across PI call sites; it does not merge their conversational histories, tool permissions, or output schemas."
  ].join("\n");
}

export function recordPiRuntimeContextEnvelopeAudit(
  db: RunnerDatabase,
  input: RuntimeSessionInput,
  envelope: PiRuntimeContextEnvelope,
  systemPrompt: string
): void {
  try {
    createPiActionEvent(db, {
      action_id: `runtime-context:${input.conversationID}:${crypto.randomUUID()}`,
      actor: "pi_runtime_context",
      conversation_id: input.conversationID,
      event_type: "runtime_context_projected",
      issue_id: positiveInteger(input.issueID),
      payload_json: JSON.stringify({
        schema_version: envelope.schema_version,
        identity: envelope.identity,
        invocation: envelope.invocation,
        target: envelope.target,
        memory_refs: envelope.durable_context.memory_items.map((item) => ({
          authority: item.authority,
          memory_key: item.memory_key,
          reference: item.reference,
          retrieval_scope: item.retrieval_scope
        })),
        retrieval_scopes: envelope.durable_context.retrieval_scopes,
        truncation: envelope.durable_context.truncation,
        system_prompt_sha256: createHash("sha256").update(systemPrompt).digest("hex")
      }),
      project_id: envelope.target.project_id,
      reason: "projected shared PI identity, exact target, and durable context into a profile-scoped runtime"
    });
  } catch (error) {
    console.warn("[pi-runtime] failed to audit runtime context projection:", safeError(error));
  }
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
