type FeishuPiActionDecision = "approve" | "approve_always" | "reject" | "request_changes" | "snooze";

export type FeishuPiActionCardAction = {
  actionID?: string;
  chatID?: string;
  comment?: string;
  decision: FeishuPiActionDecision;
  piActionID: string;
  snoozeMinutes?: number;
  userID?: string;
  userOpenID?: string;
};

const PI_ACTION_CARD_ACTION = "pi_action_resolve";

export function normalizeFeishuPiActionCardAction(raw: unknown): FeishuPiActionCardAction | null {
  const root = recordValue(raw);
  if (cleanString(recordValue(root.header).event_type) !== "card.action.trigger") return null;
  const event = recordValue(root.event);
  const action = recordValue(event.action);
  const value = recordValue(action.value);
  if (cleanString(value.action) !== PI_ACTION_CARD_ACTION) return null;
  const piActionID = cleanString(value.pi_action_id || value.action_id);
  const decision = normalizeDecision(cleanString(value.decision));
  if (piActionID === "" || !decision) return null;
  const context = recordValue(event.context);
  const operatorID = recordValue(recordValue(event.operator).operator_id);
  return {
    actionID: cleanString(recordValue(root.header).event_id),
    chatID: cleanString(context.open_chat_id || context.chat_id),
    comment: cleanString(value.comment || value.reason),
    decision,
    piActionID,
    snoozeMinutes: positiveNumber(value.snooze_minutes),
    userID: cleanString(operatorID.user_id || operatorID.userId),
    userOpenID: cleanString(operatorID.open_id || operatorID.openId)
  };
}

export function piActionApprovalActionID(actionID: string): string {
  return `pi_action:${actionID}`;
}

export function piActionIDFromApprovalActionID(value: string): string {
  const text = cleanString(value);
  return text.startsWith("pi_action:") ? cleanString(text.slice("pi_action:".length)) : "";
}

function normalizeDecision(value: string): FeishuPiActionDecision | null {
  if (["approve", "approved", "execute"].includes(value)) return "approve";
  if (["approve_always", "always_allow", "allow_always"].includes(value)) return "approve_always";
  if (["reject", "rejected", "deny", "denied"].includes(value)) return "reject";
  if (["request_changes", "changes_requested", "request-changes"].includes(value)) return "request_changes";
  if (["snooze", "defer", "later"].includes(value)) return "snooze";
  return null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
