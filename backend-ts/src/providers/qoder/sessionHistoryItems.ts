import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { entryID, compactObject, firstNonEmpty, historyText, safeHistoryJSON } from "./sessionHistoryMetadata.ts";

export function transcriptItems(entry: Record<string, unknown>, entryIndex: number): Array<Record<string, unknown>> {
  const type = cleanString(entry.type);
  const message = objectValue(entry.message);
  const content = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  const items = content.flatMap((value, index) => contentItem(entry, objectValue(value), `${entryID(entry, entryIndex)}:${index}`));
  if (type === "user" && entry.tool_use_result !== undefined && !items.some((item) => item.type === "custom_tool_call_output")) {
    items.push(toolResultItem(entryID(entry, entryIndex), entry.tool_use_result));
  }
  if (type === "system") {
    const system = systemItem(entry, entryIndex);
    return system ? [system] : [];
  }
  if (items.length > 0) return items;
  if (type === "user" || type === "assistant") return [unknownItem(entry, entryIndex)];
  return Object.keys(entry).length > 0 ? [unknownItem(entry, entryIndex)] : [];
}

export function contentItem(
  entry: Record<string, unknown>,
  block: Record<string, unknown>,
  fallbackID: string
): Array<Record<string, unknown>> {
  const entryType = cleanString(entry.type);
  const blockType = cleanString(block.type);
  const id = cleanString(block.id) || cleanString(block.tool_use_id) || fallbackID;
  const agentID = cleanString(entry.parent_agent_id);
  if (blockType === "text") {
    const text = redactSensitiveText(cleanString(block.text));
    if (!text) return [];
    return [entryType === "assistant"
      ? compactObject({ id, type: "agentMessage", text, subagent_id: agentID })
      : { id, type: "userMessage", content: [{ type: "input_text", text }] }];
  }
  if (["thinking", "reasoning"].includes(blockType)) {
    const text = redactSensitiveText(firstNonEmpty(cleanString(block.thinking), cleanString(block.text), historyText(block.content)));
    return text ? [{ id, type: "reasoning", content: [{ type: "text", text }] }] : [];
  }
  if (blockType === "tool_use") return [toolUseItem(id, block)];
  if (["tool_result", "tool_use_result"].includes(blockType)) return [toolResultItem(id, block.content ?? block)];
  return [unknownItem({ ...block, parent_type: entryType }, 0, id)];
}

export function toolUseItem(id: string, block: Record<string, unknown>): Record<string, unknown> {
  const name = cleanString(block.name) || "tool";
  const input = objectValue(redactRegisteredSecrets(objectValue(block.input)));
  if (name === "Bash") {
    return {
      id,
      type: "commandExecution",
      command: redactSensitiveText(firstNonEmpty(cleanString(input.command), cleanString(input.cmd))),
      cwd: redactSensitiveText(cleanString(input.cwd)),
      text: "",
      status: "completed"
    };
  }
  if (["Edit", "Write", "NotebookEdit"].includes(name)) {
    return {
      id,
      type: "fileChange",
      path: redactSensitiveText(firstNonEmpty(cleanString(input.file_path), cleanString(input.path), cleanString(input.notebook_path))),
      text: safeHistoryJSON(input),
      status: "completed"
    };
  }
  if (["Agent", "Task"].includes(name)) {
    return {
      id,
      type: "subagent",
      name,
      input,
      status: "running"
    };
  }
  return { id, type: "custom_tool_call", name, input };
}

export function toolResultItem(id: string, value: unknown): Record<string, unknown> {
  const record = objectValue(value);
  return {
    id: cleanString(record.tool_use_id) || id,
    type: "custom_tool_call_output",
    output: historyText(record.content ?? value),
    status: record.is_error === true ? "failed" : "completed"
  };
}

export function systemItem(entry: Record<string, unknown>, entryIndex: number): Record<string, unknown> | null {
  const subtype = cleanString(entry.subtype);
  const id = entryID(entry, entryIndex);
  if (subtype.startsWith("task_")) {
    return compactObject({
      id,
      type: "subagent",
      name: firstNonEmpty(cleanString(entry.subagent_type), "Qoder subagent"),
      task_id: cleanString(entry.task_id),
      status: firstNonEmpty(cleanString(entry.status), cleanString(objectValue(entry.patch).status), "running"),
      text: redactSensitiveText(firstNonEmpty(cleanString(entry.summary), cleanString(entry.description), cleanString(objectValue(entry.patch).error))),
      usage: redactRegisteredSecrets(objectValue(entry.usage))
    });
  }
  if (subtype === "permission_denied") {
    return compactObject({
      id,
      type: "permission",
      name: cleanString(entry.tool_name),
      status: "denied",
      text: redactSensitiveText(firstNonEmpty(cleanString(entry.message), cleanString(entry.decision_reason))),
      tool_use_id: cleanString(entry.tool_use_id)
    });
  }
  if (["init", "status", "session_state_changed", "session_title_changed"].includes(subtype)) return null;
  return unknownItem(entry, entryIndex);
}

export function unknownItem(entry: Record<string, unknown>, entryIndex: number, explicitID = ""): Record<string, unknown> {
  return {
    id: explicitID || entryID(entry, entryIndex),
    type: "qoderNative",
    native_type: cleanString(entry.type) || "unknown",
    native_subtype: cleanString(entry.subtype),
    text: safeHistoryJSON(entry)
  };
}
