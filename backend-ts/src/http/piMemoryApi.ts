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
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiMemoryContext = { database: RunnerDatabase };

export function registerPiMemoryRoutes(router: Router, context: PiMemoryContext): void {
  router.get("/api/pi/memory", (request) => json(listPiMemoryItems(context.database, memoryFilter(request))));
  router.post("/api/pi/memory", async (request) => createMemoryResponse(context, request));
  router.patch("/api/pi/memory/:id", async (request) => patchMemoryResponse(context, request));
  router.delete("/api/pi/memory/:id", (request) => deleteMemoryResponse(context, request));
}

async function createMemoryResponse(context: PiMemoryContext, request: Request): Promise<Response> {
  const body = normalizeMemoryInput(await parseObjectBody(request), true);
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
  if (isCreate && cleanString(output.id) === "") output.id = crypto.randomUUID();
  return output;
}

const STRING_FIELDS = [
  "id", "scope", "scope_id", "kind", "content", "source_type", "source_id", "confidence"
] as const;
const FLAG_FIELDS = ["pinned", "disabled"] as const;

function memoryFilter(request: Request): PiMemoryItemFilter {
  const params = new URL(request.url).searchParams;
  return {
    disabled: disabledParam(params.get("disabled")),
    scope: cleanString(params.get("scope")),
    scopeId: cleanString(params.get("scope_id"))
  };
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
