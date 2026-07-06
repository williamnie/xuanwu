import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiMemoryItem,
  deletePiMemoryItem,
  getPiMemoryItem,
  listPiMemoryItems,
  updatePiMemoryItem,
  type PiMemoryItemFilter,
  type PiMemoryItemInput
} from "../db/repositories/pi.ts";
import { assertMemoryContentSafe } from "../pi/memoryPolicy.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiMemoryContext = { database: RunnerDatabase };

export function registerPiMemoryRoutes(router: Router, context: PiMemoryContext): void {
  router.get("/api/pi/memory", (request) => json(listPiMemoryItems(context.database, memoryFilter(request))));
  router.post("/api/pi/memory", async (request) => createMemoryResponse(context, request));
  router.post("/api/pi/memory/candidates", async (request) => createCandidateResponse(context, request));
  router.post("/api/pi/memory/:id/approve", (request) => reviewMemoryResponse(context, request, 0));
  router.post("/api/pi/memory/:id/promote", (request) => reviewMemoryResponse(context, request, 0));
  router.post("/api/pi/memory/:id/disable", (request) => reviewMemoryResponse(context, request, 1));
  router.post("/api/pi/memory/:id/pin", (request) => pinMemoryResponse(context, request));
  router.post("/api/pi/memory/:id/forget", (request) => forgetMemoryResponse(context, request));
  router.patch("/api/pi/memory/:id", async (request) => patchMemoryResponse(context, request));
  router.delete("/api/pi/memory/:id", (request) => deleteMemoryResponse(context, request));
}

async function createMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const body = normalizeMemoryInput(await parseObjectBody(request), true);
  return writeResponse(() => createPiMemoryItem(context.database, body), 201);
}

async function createCandidateResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const body = normalizeMemoryInput(await parseObjectBody(request), true);
  body.disabled = 1;
  return writeResponse(() => createPiMemoryItem(context.database, body), 201);
}

async function patchMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const id = memoryID(request);
  if (!getPiMemoryItem(context.database, id)) throw new HttpError(404, "资源不存在");
  const body = normalizeMemoryInput(await parseObjectBody(request), false);
  return writeResponse(() => updatePiMemoryItem(context.database, id, body));
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

function reviewMemoryResponse(context: PiMemoryContext, request: Request, disabled: number): Promise<Response> {
  const id = memoryID(request);
  if (!getPiMemoryItem(context.database, id)) throw new HttpError(404, "资源不存在");
  return writeResponse(() => updatePiMemoryItem(context.database, id, { disabled }));
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
  "citation_type", "citation_id", "citation_label", "citation_url", "confidence"
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

function integerFlag(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isInteger(value) && value !== 0 ? 1 : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
