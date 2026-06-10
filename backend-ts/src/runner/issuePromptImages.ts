import type { RunnerDatabase } from "../db/database.ts";
import { getUpload } from "../db/repositories/uploads.ts";
import type { ProviderPromptImage } from "../providers/types.ts";

const ATTACHMENT_URL_PATTERN = /attachment:\/\/([A-Za-z0-9_-]+)/g;

export function issuePromptImages(db: RunnerDatabase, prompt: string): ProviderPromptImage[] {
  const images: ProviderPromptImage[] = [];
  for (const id of attachmentIDs(prompt)) {
    const upload = getUpload(db, id);
    if (!upload) continue;
    images.push({ detail: "high", path: upload.storage_path, type: "localImage" });
  }
  return images;
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
