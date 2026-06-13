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

export function buildFeishuApprovalCard(input: {
  approvalID: string;
  issueID?: number;
  text: string;
}): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: input.text },
      {
        tag: "action",
        actions: [
          approvalButton(input.approvalID, "approve", "turn", "批准一次", "primary"),
          approvalButton(input.approvalID, "approve_session", "session", "本 session 批准", "primary"),
          approvalButton(input.approvalID, "deny", "turn", "拒绝", "danger"),
          approvalButton(input.approvalID, "defer", "turn", "暂缓", "default")
        ]
      }
    ],
    header: {
      template: "orange",
      title: { tag: "plain_text", content: input.issueID ? `Issue #${input.issueID} 等待授权` : "Codex 等待授权" }
    }
  };
}

export function normalizeFeishuApprovalAction(raw: unknown): FeishuApprovalAction | null {
  const root = recordValue(raw);
  if (cleanString(recordValue(root.header).event_type) !== "card.action.trigger") return null;
  const action = recordValue(recordValue(root.event).action);
  const value = recordValue(action.value);
  if (cleanString(value.action) !== APPROVAL_ACTION) return null;
  const requestID = cleanString(value.approval_id || value.request_id);
  const decision = cleanString(value.decision);
  if (requestID === "" || decision === "") return null;
  const event = recordValue(root.event);
  const context = recordValue(event.context);
  const operatorID = recordValue(recordValue(event.operator).operator_id);
  return {
    actionID: cleanString(recordValue(root.header).event_id),
    chatID: cleanString(context.open_chat_id || context.chat_id),
    decision,
    requestID,
    scope: cleanString(value.scope),
    userID: cleanString(operatorID.user_id || operatorID.userId),
    userOpenID: cleanString(operatorID.open_id || operatorID.openId)
  };
}

function approvalButton(
  approvalID: string,
  decision: string,
  scope: string,
  label: string,
  type: string
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    value: { action: APPROVAL_ACTION, approval_id: approvalID, decision, scope }
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
