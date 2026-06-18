import type { RunnerDatabase } from "../db/database.ts";
import { getPiAction, type PiAction } from "../db/repositories/pi.ts";

export type GuardianActionLeaseInput = {
  actionType: string;
  idempotencyKey: string;
  issueID?: number;
  now?: Date;
  owner: string;
  projectID?: string;
  runGroupID?: string;
  ttlMs?: number;
};

export type GuardianActionLeaseResult =
  | { action?: PiAction; idempotency_key: string; lease_key: string; status: "acquired" | "idempotent_replay"; until: string }
  | { action?: PiAction; idempotency_key: string; lease_key: string; status: "held"; until: string };

export function acquireGuardianActionLease(
  db: RunnerDatabase,
  input: GuardianActionLeaseInput
): GuardianActionLeaseResult {
  const idempotencyKey = requiredClean(input.idempotencyKey, "idempotencyKey");
  const replay = actionByIdempotencyKey(db, idempotencyKey);
  const leaseKey = guardianActionLeaseKey(input);
  if (replay) return replayResult(replay, idempotencyKey, leaseKey);
  const now = input.now ?? new Date();
  const held = activeLeaseHolder(db, leaseKey, iso(now));
  if (held) return heldResult(held, idempotencyKey, leaseKey);
  return {
    idempotency_key: idempotencyKey,
    lease_key: leaseKey,
    status: "acquired",
    until: iso(new Date(now.getTime() + (input.ttlMs ?? actionLeaseTtlMs(input.actionType))))
  };
}

export function guardianActionLeaseKey(input: {
  actionType: string; issueID?: number; projectID?: string; runGroupID?: string;
}): string {
  const projectID = cleanString(input.projectID) || "global";
  const runGroupID = cleanString(input.runGroupID);
  const scope = input.issueID && input.issueID > 0 ? `issue:${input.issueID}` :
    runGroupID !== "" ? `group:${runGroupID}` : "global";
  return `${projectID}:${scope}:${cleanString(input.actionType)}`;
}

export function actionLeaseTtlMs(actionType: string): number {
  return ["session.resume_followup", "session.steer", "issue.retry", "issue.state_repair"].includes(actionType) ? 5 * 60_000 : 30_000;
}

function replayResult(action: PiAction, idempotencyKey: string, leaseKey: string): GuardianActionLeaseResult {
  return { action, idempotency_key: idempotencyKey, lease_key: leaseKey, status: "idempotent_replay", until: action.lease_expires_at };
}

function heldResult(action: PiAction, idempotencyKey: string, leaseKey: string): GuardianActionLeaseResult {
  return { action, idempotency_key: idempotencyKey, lease_key: leaseKey, status: "held", until: action.lease_expires_at };
}

function actionByIdempotencyKey(db: RunnerDatabase, idempotencyKey: string): PiAction | null {
  if (idempotencyKey === "") return null;
  const row = db.sqlite.query<{ id: string }, [string]>(
    `select id from pi_actions where idempotency_key=? order by created_at asc, id asc limit 1`
  ).get(idempotencyKey);
  return row ? getPiAction(db, row.id) : null;
}

function activeLeaseHolder(db: RunnerDatabase, leaseKey: string, timestamp: string): PiAction | null {
  if (leaseKey === "") return null;
  const row = db.sqlite.query<{ id: string }, [string, string]>(
    `select id from pi_actions where lease_key=? and status in ('candidate','pending','approved','executing')
      and (lease_expires_at='' or lease_expires_at>?)
      order by created_at asc, id asc limit 1`
  ).get(leaseKey, timestamp);
  return row ? getPiAction(db, row.id) : null;
}

function requiredClean(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
