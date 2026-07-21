import type { FeishuNormalizedMessageEvent } from "./feishu.ts";
import { recordValue } from "./feishuShared.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type FeishuProjectSelectionProject = { id: string; name?: string };
export type FeishuProjectSelectionAction = {
  action_id: string;
  chat_id: string;
  message_id: string;
  project_id: string;
  selection_id: string;
  user_id: string;
  user_open_id: string;
};
export type FeishuProjectSelectionCardInput = {
  candidates: FeishuProjectSelectionProject[];
  originalPrompt: string;
  selectionId: string;
};

const ACTION_ID = "feishu_project_select";
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const MAX_PROMPT_PREVIEW_LENGTH = 80;

export function buildFeishuProjectSelectionCard(input: FeishuProjectSelectionCardInput): Record<string, unknown> {
  const buttons = input.candidates.slice(0, 8).map(projectButton(input.selectionId)).filter((item) => item !== null);
  return {
    config: { wide_screen_mode: true },
    elements: [
      markdown(`我收到你的请求：“${promptPreview(input.originalPrompt)}”\n请选择 Runner 项目。`),
      {
        tag: "action",
        actions: buttons
      },
      markdown("项目不在列表里也可以重新发送请求，并在消息里带上项目名或 issue id。")
    ],
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "请选择 Runner 项目" }
    }
  };
}

export function normalizeFeishuProjectSelectionAction(raw: unknown): FeishuProjectSelectionAction | null {
  const root = recordValue(raw);
  const nested = recordValue(root.event);
  const event = Object.keys(nested).length > 0 ? nested : root;
  const eventType = cleanString(recordValue(root.header).event_type || root.event_type);
  if (eventType !== "card.action.trigger") return null;
  const action = recordValue(event.action);
  const value = selectedValue(action);
  if (cleanString(value.action) !== ACTION_ID) return null;
  const context = recordValue(event.context);
  const operator = recordValue(event.operator);
  const operatorID = Object.keys(recordValue(operator.operator_id)).length > 0
    ? recordValue(operator.operator_id)
    : operator;
  const selectionID = cleanString(value.selection_id);
  const projectID = cleanString(value.project_id);
  if (selectionID === "" || projectID === "") return null;
  return {
    action_id: cleanString(recordValue(root.header).event_id || root.event_id),
    chat_id: cleanString(context.open_chat_id || context.chat_id),
    message_id: cleanString(context.open_message_id || context.message_id),
    project_id: projectID,
    selection_id: selectionID,
    user_id: cleanString(operatorID.user_id || operatorID.userId),
    user_open_id: cleanString(operatorID.open_id || operatorID.openId)
  };
}

export function selectionChatIdFromEvent(event: FeishuNormalizedMessageEvent): string {
  return event.chat_id;
}

export function selectionUserIdFromEvent(event: FeishuNormalizedMessageEvent): string {
  return event.sender.id;
}

export function selectionUserOpenIdFromEvent(event: FeishuNormalizedMessageEvent): string {
  return event.sender.open_id;
}

function selectedValue(action: Record<string, unknown>): Record<string, unknown> {
  const selected = recordValue(action.option || action.selected_option);
  const optionValue = recordValue(selected.value);
  return { ...recordValue(action.value), ...optionValue };
}

function projectButton(selectionId: string): (project: FeishuProjectSelectionProject) => Record<string, unknown> | null {
  return (project) => {
    const id = cleanString(project.id);
    if (id === "") return null;
    return {
      tag: "button",
      text: { tag: "plain_text", content: projectLabel(project) },
      type: "primary",
      value: { action: ACTION_ID, project_id: id, selection_id: cleanString(selectionId) }
    };
  };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

function projectLabel(project: FeishuProjectSelectionProject): string {
  const id = cleanString(project.id);
  const name = cleanString(project.name);
  return name === "" || name === id ? id : `${name}（${id}）`;
}

function promptPreview(value: string): string {
  const safe = redactSensitiveText(cleanString(value))
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(/\s+/g, " ");
  return safe.length > MAX_PROMPT_PREVIEW_LENGTH
    ? `${safe.slice(0, MAX_PROMPT_PREVIEW_LENGTH - 1)}…`
    : safe;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
