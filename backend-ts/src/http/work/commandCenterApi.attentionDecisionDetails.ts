import type { RunnerDatabase } from "../../db/database.ts";
import { getPersistedAttention, persistAttentionCommand } from "../../domain/attention/persistence.ts";
import { getActionProposal, getPiAction, getPiApprovalRequest } from "../../db/repositories/pi.ts";
import type { AttentionCommand, AttentionRecord, AttentionTransitionAudit } from "../../domain/attention/contracts.ts";
import { HttpError, json, parseJsonBody } from "../errors.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import type { Router } from "../router.ts";
import { resolveAttentionDecision } from "./attentionDecisionService.ts";
import { piActionGateDiagnostic } from "../../pi/actions/actionGateDiagnostic.ts";
import { buildCommandCenterInbox, commandCenterInboxReaders } from "./commandCenterInbox.ts";
import { cleanString } from "../../util/values.ts";
import type { CommandCenterRouteOptions } from "./commandCenterApi.model.ts";
import { readInboxAttention, commandCenterResponse, attentionSummary } from "./commandCenterApi.attentionDetails.ts";
import { buildCommandCenterSummary, routeValue, compactRecord } from "./commandCenterApi.systemHealthSection.ts";
import { safeRecord } from "./commandCenterApi.piActionAttentionDetails.ts";

export function registerCommandCenterRoutes(
  router: Router,
  context: ReadApiContext,
  options: CommandCenterRouteOptions = {}
): void {
  const readDatabase = context.readDatabase ?? context.database;
  router.get("/api/command-center/inbox", (request) => {
    const now = options.now?.() ?? new Date();
    const defaults = commandCenterInboxReaders(readDatabase, () => readInboxAttention(readDatabase, now));
    return json(buildCommandCenterInbox(request, { ...defaults, ...options.inboxReaders }));
  });
  router.get("/api/command-center/summary", (request) => commandCenterResponse(() => (
    buildCommandCenterSummary(context, request, options)
  )));
  router.get("/api/command-center/attention/:id", (request) => attentionDetailResponse(readDatabase, request));
  router.post("/api/command-center/attention/:id/actions/:action", async (request) => (
    attentionCommandResponse(context, request)
  ));
}

export function attentionDetailResponse(db: RunnerDatabase, request: Request): Response {
  const id = routeValue(request, "attention");
  const attention = getPersistedAttention(db, id);
  if (!attention) throw new HttpError(404, "Attention not found");
  return json({
    attention: attentionSummary(db, attention),
    decisions: attentionDecisionDetails(db, attention)
  });
}

export async function attentionCommandResponse(context: ReadApiContext, request: Request): Promise<Response> {
  const id = routeValue(request, "attention");
  const action = routeValue(request, "actions");
  const current = getPersistedAttention(context.database, id);
  if (!current) throw new HttpError(404, "Attention not found");
  const body = await parseJsonBody(request);
  if (action !== "acknowledge" && action !== "snooze") {
    const object = objectValue(body, "Attention decision body");
    const decision = await resolveAttentionDecision(context, {
      action,
      body: object,
      relatedRefs: current.related_refs,
      sourceRefs: current.source_refs
    });
    const refreshed = getPersistedAttention(context.database, id);
    return json({ attention: refreshed ? attentionSummary(context.database, refreshed) : null, decision });
  }
  const command = attentionCommandInput(action, body);
  try {
    const result = persistAttentionCommand(context.database, id, command);
    return json({ attention: attentionSummary(context.database, result.attention), mutation: { audit_event: result.audit_event, replayed: false } });
  } catch (error) {
    throw new HttpError(409, error instanceof Error ? error.message : "Attention command failed");
  }
}

export function attentionDecisionDetails(db: RunnerDatabase, attention: AttentionRecord): Array<Record<string, unknown>> {
  const details: Array<Record<string, unknown>> = [];
  for (const source of attention.source_refs) {
    if (source.authority === "pi_approval_requests") {
      const approval = getPiApprovalRequest(db, source.local_id);
      if (approval) details.push({
        gate: {
          authorization_source: "provider_callback",
          blocked_layer: "provider_execution_policy",
          can_approve: ["pending", "delivered", "resolve_failed"].includes(approval.status),
          decision: "ask",
          expires_at: "",
          freshness: ["pending", "delivered", "resolve_failed"].includes(approval.status) ? "current" : "terminal",
          reason: approval.summary || approval.request_summary || "Provider 工具调用需要确认",
          reason_code: "provider_tool_approval_required",
          scope: compactRecord({ project_id: approval.project_id, run_id: approval.run_id || approval.session_id }),
          user_action: "核对 Provider 工具调用及目标后，批准当前调用或拒绝。"
        },
        kind: "provider_approval",
        ref: `approval:${approval.approval_id}`,
        request_type: approval.request_type,
        risk: approval.risk,
        status: approval.status,
        summary: approval.summary || approval.request_summary,
        provider: approval.provider,
        project_id: approval.project_id,
        run_id: approval.run_id || approval.session_id
      });
    }
    if (source.authority === "pi_actions") {
      const action = getPiAction(db, source.local_id);
      if (action) {
        const payload = safeRecord(action.payload_json);
        details.push({
        action_type: action.action_type,
        capability_id: cleanString(payload.capability_id),
        expires_at: action.lease_expires_at,
        gate: piActionGateDiagnostic(db, action),
        gate_decision: action.gate_decision,
        gate_reason: action.gate_reason,
        kind: "pi_action",
        ref: `pi_action:${action.id}`,
        risk: action.risk_level,
        project_id: action.project_id,
        status: action.status,
        summary: action.rationale || action.action_type
      });
      }
    }
  }
  for (const ref of attention.related_refs.filter((value) => value.startsWith("proposal:"))) {
    const proposal = getActionProposal(db, ref.slice("proposal:".length));
    if (!proposal) continue;
    details.push({
      actions: proposal.actions.map((action) => ({
        id: action.id,
        requires_approval: action.requires_approval,
        risk: action.risk,
        status: action.execution_status || "pending",
        summary: action.summary,
        type: action.type
      })),
      gate: {
        authorization_source: "source_policy",
        blocked_layer: "source_policy",
        can_approve: proposal.status === "proposed",
        decision: "ask",
        expires_at: "",
        freshness: proposal.status === "proposed" ? "current" : "terminal",
        reason: proposal.summary,
        reason_code: "source_proposal_approval_required",
        scope: {},
        user_action: "核对来源事实和每个动作后，批准或拒绝整份 Proposal。"
      },
      kind: "proposal",
      ref,
      risk: proposal.actions.some((action) => action.risk === "high") ? "high" :
        proposal.actions.some((action) => action.risk === "medium") ? "medium" : "low",
      status: proposal.status,
      summary: proposal.summary
    });
  }
  return details;
}

export function attentionCommandInput(action: "acknowledge" | "snooze", value: unknown): AttentionCommand {
  const body = objectValue(value, "Attention command body");
  const expectedRevision = body.expected_revision;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new HttpError(400, "expected_revision must be a non-negative integer");
  }
  const audit = objectValue(body.audit, "audit") as AttentionTransitionAudit;
  if (!audit.actor || !audit.gate || typeof audit.event_id !== "string" || typeof audit.reason !== "string" ||
      typeof audit.correlation_id !== "string" || typeof audit.occurred_at !== "string") {
    throw new HttpError(400, "invalid Attention audit");
  }
  if (action === "snooze" && typeof body.snoozed_until !== "string") {
    throw new HttpError(400, "snoozed_until is required for snooze");
  }
  return {
    action,
    audit,
    expected_revision: expectedRevision,
    ...(action === "snooze" ? { snoozed_until: body.snoozed_until as string } : {})
  };
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}
