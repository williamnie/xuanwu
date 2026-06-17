import type { RunnerDatabase } from "../db/database.ts";
import {
  getPiConversation,
  listArchivedPiConversations,
  restorePiConversation
} from "../db/repositories/pi.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiConversationArchiveContext = {
  database: RunnerDatabase;
};

export function registerPiConversationArchiveRoutes(
  router: Router,
  context: PiConversationArchiveContext
): void {
  router.get("/api/pi/conversations/archived", (request) => archivedConversationListResponse(context, request));
  router.post("/api/pi/conversations/:id/restore", (request) => piConversationRestoreResponse(context, request));
}

function archivedConversationListResponse(
  context: PiConversationArchiveContext,
  request: Request
): Response {
  const params = new URL(request.url).searchParams;
  return json(listArchivedPiConversations(context.database, {
    cursor: cleanString(params.get("cursor")),
    pageSize: Number(params.get("page_size") || 0),
    projectId: cleanString(params.get("project_id"))
  }));
}

function piConversationRestoreResponse(
  context: PiConversationArchiveContext,
  request: Request
): Response {
  const conversation = getPiConversation(context.database, pathPart(request, "conversations"));
  if (!conversation) throw new HttpError(404, "资源不存在");
  const restored = restorePiConversation(context.database, conversation.id);
  return json({
    project_id: restored.project_id || null,
    session_id: restored.id
  });
}

function pathPart(request: Request, marker: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf(marker) + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, `${marker} id 不能为空`);
  return decodeURIComponent(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
