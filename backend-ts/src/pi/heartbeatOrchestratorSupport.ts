import type { RunnerDatabase } from "../db/database.ts";
import { createPiHeartbeatEvent, isPiHeartbeatPaused, updatePiDelegationHeartbeat, type PiDelegation } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { HeartbeatInput } from "./heartbeatTypes.ts";

const DELEGATION_NEXT_MS = 60_000;

export function heartbeatContext(input: HeartbeatInput) {
  const kind = input.kind ?? "project";
  const now = input.now ?? new Date();
  const projectID = input.projectID.trim();
  const delegationID = input.delegation?.id ?? "";
  if (projectID === "") throw new Error("project id is required");
  if (!getProject(input.database, projectID)) throw new Error("project not found");
  const scope = delegationID || "project";
  const heartbeatID = `${kind}:${projectID}:${scope}:${crypto.randomUUID()}`;
  return { delegationID, heartbeatID, kind, now, nowText: iso(now), projectID };
}

export function isPaused(db: RunnerDatabase, ctx: ReturnType<typeof heartbeatContext>): boolean {
  return isPiHeartbeatPaused(db, { scopeId: ctx.projectID, scopeType: "project" }) ||
    (ctx.delegationID !== "" && isPiHeartbeatPaused(db, { scopeId: ctx.delegationID, scopeType: "delegation" }));
}

export function recordHeartbeatEvent(
  db: RunnerDatabase,
  ctx: ReturnType<typeof heartbeatContext>,
  eventType: string,
  payload: unknown,
  error = ""
): void {
  createPiHeartbeatEvent(db, {
    delegation_id: ctx.delegationID,
    error,
    event_type: eventType,
    heartbeat_id: ctx.heartbeatID,
    payload_json: JSON.stringify(payload ?? {}),
    project_id: ctx.projectID
  });
}

export function updateDelegationTick(db: RunnerDatabase, delegation: PiDelegation | undefined, lastAt: string, nextAt: string): void {
  if (!delegation) return;
  updatePiDelegationHeartbeat(db, delegation.id, lastAt, nextAt || iso(new Date(Date.parse(lastAt) + DELEGATION_NEXT_MS)));
}

export function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
