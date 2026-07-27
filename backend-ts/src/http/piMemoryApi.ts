import type { RunnerDatabase } from "../db/database.ts";
import {
  deletePiMemoryItem,
  getPiMemoryItem,
  listPiMemoryItems,
  rememberPiMemoryItem,
  updatePiMemoryItem,
  type PiMemoryItemFilter,
  type PiMemoryItemInput
} from "../db/repositories/pi.ts";
import { applyPiMemoryBatchAction, type PiMemoryBatchAction } from "../pi/memoryLifecycle.ts";
import { assertMemoryContentSafe, reusableMemoryRejection } from "../pi/memoryPolicy.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiMemoryContext = { database: RunnerDatabase };

export function registerPiMemoryRoutes(router: Router, context: PiMemoryContext): void {
  router.get("/api/pi/memory", (request) => json(listPiMemoryItems(context.database, memoryFilter(request))));
  router.get("/api/pi/memory/digest", () => retiredReviewQueueResponse());
  router.post("/api/pi/memory", async (request) => createMemoryResponse(context, request));
  router.post("/api/pi/memory/batch", async (request) => batchMemoryResponse(context, request));
  router.post("/api/pi/memory/candidates", () => retiredReviewQueueResponse());
  router.post("/api/pi/memory/:id/approve", () => retiredReviewQueueResponse());
  router.post("/api/pi/memory/:id/promote", () => retiredReviewQueueResponse());
  router.post("/api/pi/memory/:id/enable", (request) => enableMemoryResponse(context, request));
  router.post("/api/pi/memory/:id/disable", (request) => disableMemoryResponse(context, request));
  router.post("/api/pi/memory/:id/pin", (request) => pinMemoryResponse(context, request));
  router.post("/api/pi/memory/:id/forget", (request) => forgetMemoryResponse(context, request));
  router.patch("/api/pi/memory/:id", async (request) => patchMemoryResponse(context, request));
  router.delete("/api/pi/memory/:id", (request) => deleteMemoryResponse(context, request));
}

async function batchMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const body = await parseObjectBody(request);
  return writeResponse(() => applyPiMemoryBatchAction(context.database, {
    action: batchAction(body.action),
    ids: idList(body.ids)
  }));
}

async function createMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const body = normalizeMemoryInput(await parseObjectBody(request), true);
  assertReusableManualMemory(body);
  body.disabled = 0;
  return writeResponse(() => rememberPiMemoryItem(context.database, body), 201);
}

async function patchMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const id = memoryID(request);
  if (!getPiMemoryItem(context.database, id)) throw new HttpError(404, "资源不存在");
  const body = normalizeMemoryInput(await parseObjectBody(request), false);
  assertReusableManualMemory({ ...getPiMemoryItem(context.database, id), ...body });
  return writeResponse(() => updatePiMemoryItem(context.database, id, body));
}

function enableMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const id = memoryID(request);
  const item = getPiMemoryItem(context.database, id);
  if (!item) throw new HttpError(404, "资源不存在");
  assertReusableManualMemory(item);
  return writeResponse(() => updatePiMemoryItem(context.database, id, { disabled: 0 }));
}

function disableMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const id = memoryID(request);
  if (!getPiMemoryItem(context.database, id)) throw new HttpError(404, "资源不存在");
  return writeResponse(() => updatePiMemoryItem(context.database, id, { disabled: 1 }));
}

function deleteMemoryResponse(context: PiMemoryContext, request: Request): Response {
  const id = memoryID(request);
  if (!getPiMemoryItem(context.database, id)) throw new HttpError(404, "资源不存在");
  return json({ deleted: deletePiMemoryItem(context.database, id) });
}

function forgetMemoryResponse(context: PiMemoryContext, request: Request): Response {
  const id = memoryID(request);
  if (!getPiMemoryItem(context.database, id)) throw new HttpError(404, "资源不存在");
  return json({ forgotten: deletePiMemoryItem(context.database, id) });
}

function pinMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const id = memoryID(request);
  if (!getPiMemoryItem(context.database, id)) throw new HttpError(404, "资源不存在");
  return writeResponse(() => updatePiMemoryItem(context.database, id, { pinned: 1 }));
}

async function writeResponse(write: () => unknown | Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function normalizeMemoryInput(input: Record<string, unknown>, isCreate: boolean): PiMemoryItemInput {
  const output: PiMemoryItemInput = {};
  for (const field of STRING_FIELDS) {
    if (hasValue(input, field)) output[field] = cleanString(input[field]);
  }
  for (const field of FLAG_FIELDS) {
    if (hasValue(input, field)) output[field] = integerFlag(input[field]);
  }
  if (hasValue(input, "occurrence_count")) output.occurrence_count = positiveInteger(input.occurrence_count);
  if (hasValue(output as Record<string, unknown>, "content")) assertSafeContent(cleanString(output.content));
  if (isCreate && cleanString(output.id) === "") output.id = crypto.randomUUID();
  return output;
}

function assertSafeContent(content: string): void {
  try {
    assertMemoryContentSafe(content);
  } catch (error) {
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

const STRING_FIELDS = [
  "id", "memory_type", "layer", "scope", "scope_id", "kind", "content", "source_type", "source_id",
  "citation_type", "citation_id", "citation_label", "citation_url", "confidence", "memory_key", "last_seen_at"
] as const;
const FLAG_FIELDS = ["pinned", "disabled"] as const;

function memoryFilter(request: Request): PiMemoryItemFilter {
  const params = new URL(request.url).searchParams;
  const statusDisabled = statusParam(params.get("status"));
  return {
    disabled: statusDisabled ?? disabledParam(params.get("disabled")),
    layer: cleanString(params.get("layer")),
    memoryType: cleanString(params.get("memory_type")),
    scope: cleanString(params.get("scope")),
    scopeId: cleanString(params.get("scope_id"))
  };
}

function statusParam(value: string | null): number | undefined {
  const text = cleanString(value).toLowerCase();
  if (text === "active") return 0;
  if (text === "candidate" || text === "disabled") return 1;
  return undefined;
}

function disabledParam(value: string | null): number | undefined {
  const text = cleanString(value).toLowerCase();
  if (text === "") return undefined;
  return text === "1" || text === "true" ? 1 : 0;
}

function memoryID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("memory") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "PI memory id 不能为空");
  return decodeURIComponent(value);
}

function hasValue(input: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(input, key) && input[key] !== null && input[key] !== undefined;
}

function batchAction(value: unknown): PiMemoryBatchAction {
  const action = cleanString(value);
  if (["disable", "enable", "forget", "pin"].includes(action)) return action as PiMemoryBatchAction;
  throw new HttpError(400, "不支持的 memory batch action");
}

function assertReusableManualMemory(input: PiMemoryItemInput): void {
  const reason = reusableMemoryRejection({
    confidence: cleanString(input.confidence),
    content: cleanString(input.content),
    evidenceRef: citationReference(input),
    kind: cleanString(input.kind),
    memoryKey: cleanString(input.memory_key),
    scope: cleanString(input.scope),
    source: "manual_settings",
    userAuthorized: true
  });
  if (reason) throw new HttpError(400, reason);
}

function citationReference(input: PiMemoryItemInput): string {
  const type = cleanString(input.citation_type);
  const id = cleanString(input.citation_id);
  return type && id ? `${type}:${id}` : "";
}

function retiredReviewQueueResponse(): never {
  throw new HttpError(410, "memory review queue has been retired; reusable memory is automatic");
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "memory batch ids 必须是数组");
  return value.map(cleanString).filter(Boolean);
}

function integerFlag(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isInteger(value) && value !== 0 ? 1 : 0;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
