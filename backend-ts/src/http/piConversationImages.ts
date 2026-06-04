import { readFileSync } from "node:fs";
import type { RunnerDatabase } from "../db/database.ts";
import { mustGetUpload } from "../db/repositories/uploads.ts";

const ATTACHMENT_URL_PATTERN = /attachment:\/\/([A-Za-z0-9_-]+)/g;

export type PiPromptImage = { data: string; mimeType: string; type: "image" };

export function piConversationPromptImages(db: RunnerDatabase, prompt: string): PiPromptImage[] {
  return attachmentIDs(prompt).map((id) => uploadImageContent(db, id));
}

function attachmentIDs(prompt: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of prompt.matchAll(ATTACHMENT_URL_PATTERN)) {
    const id = match[1]?.trim() ?? "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function uploadImageContent(db: RunnerDatabase, id: string): PiPromptImage {
  const upload = mustGetUpload(db, id);
  return {
    type: "image",
    mimeType: upload.mime_type,
    data: readFileSync(upload.storage_path).toString("base64")
  };
}
