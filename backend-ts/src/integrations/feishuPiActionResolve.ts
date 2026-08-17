import type { RunnerDatabase } from "../db/database.ts";
import { getPiAction, listPiActionEvents, type PiAction } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { resolvePiActionDecision } from "../http/piActionDecision.ts";
import type { ProjectLoopStarter } from "../http/piActionDispatch.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { recordPiActionAuditEvent } from "../pi/actionEngine.ts";
import type { FeishuPiActionCardAction } from "./feishuPiActionCards.ts";
export { resolvePiActionFromIm } from "./imPiActionResolve.ts";
export type { ImPiActionResolveInput } from "./imPiActionResolve.ts";

type ResolveContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  startProjectLoop?: ProjectLoopStarter;
};

export async function resolvePiActionFromFeishu(
  context: ResolveContext,
  action: FeishuPiActionCardAction
): Promise<{ ok: true; status: string }> {
  if (action.actionID && callbackAlreadyHandled(context.database, action)) {
    return { ok: true, status: getPiAction(context.database, action.piActionID)?.status ?? "unknown" };
  }
  const actor = feishuActor(action);
  const result = await resolvePiActionDecision(context, {
    actionID: action.piActionID,
    actor,
    comment: action.comment || "Feishu 要求修改",
    decision: action.decision,
    reason: action.comment || `Feishu ${action.decision}`,
    snoozedUntil: action.decision === "snooze" ? snoozedUntil(action.snoozeMinutes) : undefined
  });
  recordFeishuCallback(context.database, result, action, actor);
  return { ok: true, status: result.status };
}

function callbackAlreadyHandled(db: RunnerDatabase, action: FeishuPiActionCardAction): boolean {
  const callbackID = action.actionID ?? "";
  return listPiActionEvents(db, { actionId: action.piActionID })
    .some((event) => event.event_type === "feishu_callback" &&
      parsePayload(event.payload_json).callback_action_id === callbackID);
}

function recordFeishuCallback(
  db: RunnerDatabase,
  result: PiAction,
  action: FeishuPiActionCardAction,
  actor: string
): void {
  recordPiActionAuditEvent(db, result, "feishu_callback", {
    actor,
    decision: action.decision,
    payload: {
      callback_action_id: action.actionID ?? "",
      chat_id: action.chatID ?? ""
    }
  });
}

function feishuActor(action: FeishuPiActionCardAction): string {
  return `feishu:${action.userID || action.userOpenID || "unknown"}`;
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
