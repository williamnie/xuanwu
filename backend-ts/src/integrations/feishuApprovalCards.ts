import { cleanString, objectValue } from "../util/values.ts";

export type FeishuApprovalAction = {
  actionID?: string;
  chatID?: string;
  decision: string;
  requestID: string;
  scope: string;
  userID?: string;
  userOpenID?: string;
};

const APPROVAL_ACTION = "pi_approval_resolve";

export function normalizeFeishuApprovalAction(raw: unknown): FeishuApprovalAction | null {
  const root = objectValue(raw);
  if (cleanString(objectValue(root.header).event_type) !== "card.action.trigger") return null;
  const action = objectValue(objectValue(root.event).action);
  const value = objectValue(action.value);
  if (cleanString(value.action) !== APPROVAL_ACTION) return null;
  const requestID = cleanString(value.approval_id || value.request_id);
  const decision = cleanString(value.decision);
  if (requestID === "" || decision === "") return null;
  const event = objectValue(root.event);
  const context = objectValue(event.context);
  const operatorID = objectValue(objectValue(event.operator).operator_id);
  return {
    actionID: cleanString(objectValue(root.header).event_id),
    chatID: cleanString(context.open_chat_id || context.chat_id),
    decision,
    requestID,
    scope: cleanString(value.scope),
    userID: cleanString(operatorID.user_id || operatorID.userId),
    userOpenID: cleanString(operatorID.open_id || operatorID.openId)
  };
}
