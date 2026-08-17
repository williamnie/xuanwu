import type { RunnerDatabase } from "../db/database.ts";
import { getPiAction, listPiActionEvents, type PiAction } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { resolvePiActionDecision } from "../http/piActionDecision.ts";
import type { ProjectLoopStarter } from "../http/piActionDispatch.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { recordPiActionAuditEvent } from "../pi/actionEngine.ts";

export type ImPiActionResolveContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  startProjectLoop?: ProjectLoopStarter;
};

export type ImPiActionResolveInput = {
  actionID?: string;
  actor: string;
  comment?: string;
  connectorID: string;
  conversationID?: string;
  decision: "approve" | "approve_always" | "reject" | "request_changes" | "snooze";
  piActionID: string;
  snoozeMinutes?: number;
};

/** Provider-neutral PI action transition after an IM callback binding is claimed. */
export async function resolvePiActionFromIm(
  context: ImPiActionResolveContext,
  action: ImPiActionResolveInput
): Promise<{ ok: true; status: string }> {
  if (action.actionID && callbackAlreadyHandledFromIm(context.database, action)) {
    return { ok: true, status: getPiAction(context.database, action.piActionID)?.status ?? "unknown" };
  }
  const actor = action.actor;
  const result = await resolvePiActionDecision(context, {
    actionID: action.piActionID,
    actor,
    comment: action.comment || `${action.connectorID} 要求修改`,
    decision: action.decision,
    reason: action.comment || `${action.connectorID} ${action.decision}`,
    snoozedUntil: action.decision === "snooze" ? snoozedUntil(action.snoozeMinutes) : undefined
  });
  recordImCallback(context.database, result, action, actor);
  return { ok: true, status: result.status };
}

function callbackAlreadyHandledFromIm(db: RunnerDatabase, action: ImPiActionResolveInput): boolean {
  const callbackID = action.actionID ?? "";
  return listPiActionEvents(db, { actionId: action.piActionID })
    .some((event) => event.event_type === "im_callback" &&
      parsePayload(event.payload_json).callback_action_id === callbackID &&
      parsePayload(event.payload_json).connector_id === action.connectorID);
}

function recordImCallback(db: RunnerDatabase, result: PiAction, action: ImPiActionResolveInput, actor: string): void {
  recordPiActionAuditEvent(db, result, "im_callback", {
    actor,
    decision: action.decision,
    payload: {
      callback_action_id: action.actionID ?? "",
      connector_id: action.connectorID,
      conversation_id: action.conversationID ?? ""
    }
  });
}

function snoozedUntil(minutes: number | undefined): string {
  const duration = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
  return new Date(Date.now() + duration * 60_000).toISOString();
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
