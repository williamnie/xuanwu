import type { RunnerDatabase } from "../db/database.ts";
import {
  approveActionProposal,
  createActionProposal,
  getActionProposal,
  listActionProposals,
  rejectActionProposal
} from "../db/repositories/pi.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiActionProposalContext = { database: RunnerDatabase };
type JsonObject = Record<string, unknown>;

export function registerPiActionProposalRoutes(router: Router, context: PiActionProposalContext): void {
  router.get("/api/pi/action-proposals", (request) => json(listActionProposals(context.database, filter(request))));
  router.post("/api/pi/action-proposals", async (request) => createProposalResponse(context, request));
  router.get("/api/pi/action-proposals/:id", (request) => proposalResponse(context, request));
  router.post("/api/pi/action-proposals/:id/approve", async (request) => approveProposalResponse(context, request));
  router.post("/api/pi/action-proposals/:id/reject", async (request) => rejectProposalResponse(context, request));
}

async function createProposalResponse(context: PiActionProposalContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  return writeResponse(() => createActionProposal(context.database, {
    actions: arrayBody(body.actions),
    confidence: numberBody(body.confidence),
    evidence_refs: arrayBody(body.evidence_refs),
    id: cleanString(body.id),
    skill_run_id: cleanString(body.skill_run_id),
    source_item_ids: arrayBody(body.source_item_ids),
    status: cleanString(body.status),
    summary: cleanString(body.summary),
    target_hints: arrayBody(body.target_hints)
  }), 201);
}

function proposalResponse(context: PiActionProposalContext, request: Request): Response {
  const proposal = getActionProposal(context.database, proposalID(request));
  if (!proposal) throw new HttpError(404, "action proposal not found");
  return json(proposal);
}

async function approveProposalResponse(context: PiActionProposalContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const id = proposalID(request);
  requireProposal(context, id);
  return writeResponse(() => approveActionProposal(context.database, id, cleanString(body.actor)));
}

async function rejectProposalResponse(context: PiActionProposalContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const id = proposalID(request);
  requireProposal(context, id);
  return writeResponse(() => rejectActionProposal(
    context.database,
    id,
    cleanString(body.actor),
    cleanString(body.reason)
  ));
}

function writeResponse(create: () => unknown, status = 200): Response {
  try {
    return json(create(), { status });
  } catch (error) {
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

function requireProposal(context: PiActionProposalContext, id: string): void {
  if (!getActionProposal(context.database, id)) throw new HttpError(404, "action proposal not found");
}

async function objectBody(request: Request): Promise<JsonObject> {
  const body = await parseJsonBody(request);
  return body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : {};
}

function filter(request: Request) {
  const params = new URL(request.url).searchParams;
  return {
    skillRunId: cleanParam(params.get("skill_run_id") || params.get("skillRunId")),
    sourceItemId: cleanParam(params.get("source_item_id") || params.get("sourceItemId")),
    status: cleanParam(params.get("status"))
  };
}

function proposalID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = parts[parts.indexOf("action-proposals") + 1]?.trim() ?? "";
  if (id === "") throw new HttpError(400, "action proposal id is required");
  return decodeURIComponent(id);
}

function arrayBody(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberBody(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
