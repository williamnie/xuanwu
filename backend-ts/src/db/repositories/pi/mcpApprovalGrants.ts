import type { RunnerDatabase } from "../../database.ts";
import { cleanString, now, requiredString } from "./common.ts";

export type PiMcpApprovalGrant = {
  capability_fingerprint: string;
  capability_id: string;
  created_at: string;
  granted_by: string;
  id: string;
  project_id: string;
  reason: string;
  revoked_at: string;
  updated_at: string;
};

const COLUMNS = `id, project_id, capability_id, capability_fingerprint, granted_by,
  reason, revoked_at, created_at, updated_at`;

export function listPiMcpApprovalGrants(
  db: RunnerDatabase,
  filter: { capabilityID?: string; projectID?: string; activeOnly?: boolean } = {}
): PiMcpApprovalGrant[] {
  const conditions: string[] = [];
  const values: string[] = [];
  if (cleanString(filter.projectID)) {
    conditions.push("project_id=?");
    values.push(cleanString(filter.projectID));
  }
  if (cleanString(filter.capabilityID)) {
    conditions.push("capability_id=?");
    values.push(cleanString(filter.capabilityID));
  }
  if (filter.activeOnly !== false) conditions.push("revoked_at=''");
  const where = conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "";
  return db.sqlite.query<Record<string, unknown>, string[]>(
    `select ${COLUMNS} from pi_mcp_approval_grants${where} order by created_at desc, id desc`
  ).all(...values).map(mapGrant);
}

export function getActivePiMcpApprovalGrant(
  db: RunnerDatabase,
  projectID: string,
  capabilityID: string
): PiMcpApprovalGrant | null {
  return listPiMcpApprovalGrants(db, { activeOnly: true, capabilityID, projectID })[0] ?? null;
}

export function revokePiMcpApprovalGrant(db: RunnerDatabase, id: string): boolean {
  const timestamp = now();
  const result = db.sqlite.run(
    "update pi_mcp_approval_grants set revoked_at=?, updated_at=? where id=? and revoked_at=''",
    [timestamp, timestamp, requiredString(id, "id")]
  );
  return result.changes > 0;
}

export function grantPiMcpCapabilityApproval(db: RunnerDatabase, input: {
  capabilityFingerprint: string;
  capabilityID: string;
  grantedBy: string;
  projectID: string;
  reason?: string;
}): PiMcpApprovalGrant {
  const projectID = requiredString(input.projectID, "project_id");
  const capabilityID = requiredString(input.capabilityID, "capability_id");
  const timestamp = now();
  revokePiMcpApprovalGrants(db, { capabilityID, projectID }, timestamp);
  const id = crypto.randomUUID();
  db.sqlite.run(`insert into pi_mcp_approval_grants
    (id, project_id, capability_id, capability_fingerprint, granted_by, reason, revoked_at, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, '', ?, ?)`, [
    id,
    projectID,
    capabilityID,
    requiredString(input.capabilityFingerprint, "capability_fingerprint"),
    requiredString(input.grantedBy, "granted_by"),
    cleanString(input.reason),
    timestamp,
    timestamp
  ]);
  return listPiMcpApprovalGrants(db, { capabilityID, projectID })[0]!;
}

export function revokePiMcpApprovalGrants(
  db: RunnerDatabase,
  filter: { capabilityID?: string; projectID?: string; serverID?: string },
  timestamp = now()
): number {
  const conditions = ["revoked_at=''"];
  const values: string[] = [];
  if (cleanString(filter.projectID)) {
    conditions.push("project_id=?");
    values.push(cleanString(filter.projectID));
  }
  if (cleanString(filter.capabilityID)) {
    conditions.push("capability_id=?");
    values.push(cleanString(filter.capabilityID));
  }
  if (cleanString(filter.serverID)) {
    conditions.push("capability_id in (select id from pi_mcp_capabilities where server_id=?)");
    values.push(cleanString(filter.serverID));
  }
  if (values.length === 0) return 0;
  const result = db.sqlite.run(
    `update pi_mcp_approval_grants set revoked_at=?, updated_at=? where ${conditions.join(" and ")}`,
    [timestamp, timestamp, ...values]
  );
  return result.changes;
}

function mapGrant(row: Record<string, unknown>): PiMcpApprovalGrant {
  return {
    capability_fingerprint: requiredString(row.capability_fingerprint, "capability_fingerprint"),
    capability_id: requiredString(row.capability_id, "capability_id"),
    created_at: requiredString(row.created_at, "created_at"),
    granted_by: requiredString(row.granted_by, "granted_by"),
    id: requiredString(row.id, "id"),
    project_id: requiredString(row.project_id, "project_id"),
    reason: cleanString(row.reason),
    revoked_at: cleanString(row.revoked_at),
    updated_at: requiredString(row.updated_at, "updated_at")
  };
}
