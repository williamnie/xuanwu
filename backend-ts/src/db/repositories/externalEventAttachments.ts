import { redactedString } from "./externalEventRedaction.ts";

export type ExternalEventAttachment = {
  kind: string;
  local_ref: string;
  mime_type: string;
  name: string;
  ocr_text: string;
  remote_ref: string;
  vision_summary: string;
};

export type ExternalEventAttachmentInput = Partial<ExternalEventAttachment> & {
  mime?: string;
  type?: string;
};

export function attachmentContent(attachments: ExternalEventAttachment[]): string {
  if (attachments.length === 0) return "";
  return `[${attachments.length} attachment metadata item(s)]`;
}

export function normalizeAttachments(value: unknown): ExternalEventAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeAttachment).filter((item) => item.kind !== "");
}

function normalizeAttachment(value: unknown): ExternalEventAttachment {
  const item = objectValue(value);
  const kind = cleanString(item.kind) || cleanString(item.type);
  return {
    kind,
    mime_type: cleanString(item.mime_type) || cleanString(item.mime),
    name: cleanString(item.name),
    remote_ref: redactedString(cleanString(item.remote_ref), "remote_ref"),
    local_ref: redactedString(cleanString(item.local_ref), "local_ref"),
    ocr_text: cleanString(item.ocr_text),
    vision_summary: cleanString(item.vision_summary)
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
