import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { statSync } from "node:fs";

export type RetentionValue = "R1_OPERATIONAL" | "R2_DURABLE" | "R3_AUDIT" | "REVIEW_REQUIRED";

export type DistributionRow = {
  key: string;
  count: number;
  payload_bytes: number;
};

export type IssueDistributionRow = DistributionRow & {
  issue_id: number;
  project_id: string;
};

export type IssueEventsStorageAudit = {
  schema_version: "issue-events-storage-audit.v1";
  source_of_truth: "issue_events";
  snapshot: {
    database_file: string;
    file_bytes: number;
    allocated_bytes: number;
    free_bytes: number;
    issue_events_table_bytes: number;
    issue_events_index_bytes: number;
    first_event_at: string;
    last_event_at: string;
  };
  totals: {
    event_count: number;
    payload_bytes: number;
    issue_log_count: number;
    issue_log_payload_bytes: number;
    raw_payload_bytes: number;
    raw_payload_share: number;
  };
  payload_fields: Record<string, number>;
  distributions: {
    event_types: DistributionRow[];
    inner_event_types: DistributionRow[];
    projects: DistributionRow[];
    providers: DistributionRow[];
    raw_methods: Array<DistributionRow & { retention_value: RetentionValue }>;
    top_issues: IssueDistributionRow[];
    daily: DistributionRow[];
    retention_value: DistributionRow[];
  };
  duplicates: {
    fingerprint_algorithm: "sha256(type + NUL + payload)";
    unique_type_payloads: number;
    duplicate_groups: number;
    duplicate_rows: number;
    redundant_payload_bytes: number;
    redundant_payload_share: number;
    top_groups: Array<{
      count: number;
      event_type: string;
      fingerprint: string;
      payload_bytes_each: number;
      provider: string;
      raw_method: string;
      redundant_payload_bytes: number;
    }>;
  };
};

export type IssueEventsStorageGrowth = {
  interval_seconds: number;
  interval_days: number;
  event_count_delta: number;
  event_count_per_day: number;
  payload_bytes_delta: number;
  payload_bytes_per_day: number;
  raw_payload_bytes_delta: number;
  raw_payload_bytes_per_day: number;
  database_file_bytes_delta: number;
  database_file_bytes_per_day: number;
};

type AuditOptions = { duplicateLimit?: number; issueLimit?: number };
type CountBytesRow = { count: number; payload_bytes: number };
type SummaryRow = CountBytesRow & { first_event_at: string; last_event_at: string };
type SizeRow = { allocated_bytes: number; free_bytes: number };
type DbStatRow = { bytes: number; name: string };
type KeyDistributionRow = CountBytesRow & { key: string };
type RawMethodRow = KeyDistributionRow & { retention_value?: RetentionValue };
type DuplicateScanRow = {
  bytes: number;
  payload: string;
  provider: string;
  raw_method: string;
  type: string;
};
type DuplicateAggregate = Omit<DuplicateScanRow, "payload"> & { count: number };

const OPERATIONAL_METHOD = /(?:delta|updated|tokenusage|moderationmetadata|startupstatus|terminalinteraction|thread\/goal\/cleared)/i;
const DURABLE_METHOD = /^(?:item\/started|item\/completed)$/i;
const AUDIT_METHOD = /(?:turn\/(?:started|completed)|thread\/status\/changed|error|approval)/i;

export function auditIssueEventsStorage(path: string, options: AuditOptions = {}): IssueEventsStorageAudit {
  const issueLimit = boundedLimit(options.issueLimit, 25);
  const duplicateLimit = boundedLimit(options.duplicateLimit, 20);
  const sqlite = new Database(path, { readonly: true, strict: true });
  sqlite.run("pragma query_only=on");
  try {
    assertAuditSchema(sqlite);
    const summary = requiredRow<SummaryRow>(sqlite, `
      select count(*) as count,
        coalesce(sum(length(cast(payload as blob))), 0) as payload_bytes,
        coalesce(min(created_at), '') as first_event_at,
        coalesce(max(created_at), '') as last_event_at
      from issue_events
    `);
    const issueLog = requiredRow<CountBytesRow>(sqlite, `
      select count(*) as count, coalesce(sum(length(cast(payload as blob))), 0) as payload_bytes
      from issue_events where type='issue.log'
    `);
    const fieldBytes = payloadFieldBytes(sqlite);
    const rawPayloadBytes = fieldBytes.raw_payload ?? 0;
    const sizes = requiredRow<SizeRow>(sqlite, `
      select page_count * page_size as allocated_bytes, freelist_count * page_size as free_bytes
      from pragma_page_count(), pragma_page_size(), pragma_freelist_count()
    `);
    const physical = physicalIssueEventBytes(sqlite);
    const eventTypes = distribution(sqlite, `
      select type as key, count(*) as count, sum(length(cast(payload as blob))) as payload_bytes
      from issue_events group by type order by payload_bytes desc, count desc, key
    `);
    const rawMethods = distribution(sqlite, jsonDistribution("raw_method"))
      .map((row): RawMethodRow => ({ ...row, retention_value: classifyRetentionValue("issue.log", row.key) }));
    const duplicates = duplicateSummary(sqlite, summary.payload_bytes, duplicateLimit);

    return {
      schema_version: "issue-events-storage-audit.v1",
      source_of_truth: "issue_events",
      snapshot: {
        database_file: basename(path),
        file_bytes: statSync(path).size,
        allocated_bytes: sizes.allocated_bytes,
        free_bytes: sizes.free_bytes,
        issue_events_table_bytes: physical.get("issue_events") ?? 0,
        issue_events_index_bytes: [...physical.entries()]
          .filter(([name]) => name.startsWith("idx_issue_events"))
          .reduce((sum, [, bytes]) => sum + bytes, 0),
        first_event_at: summary.first_event_at,
        last_event_at: summary.last_event_at
      },
      totals: {
        event_count: summary.count,
        payload_bytes: summary.payload_bytes,
        issue_log_count: issueLog.count,
        issue_log_payload_bytes: issueLog.payload_bytes,
        raw_payload_bytes: rawPayloadBytes,
        raw_payload_share: ratio(rawPayloadBytes, issueLog.payload_bytes)
      },
      payload_fields: fieldBytes,
      distributions: {
        event_types: eventTypes,
        inner_event_types: distribution(sqlite, jsonDistribution("type")),
        projects: distribution(sqlite, `
          select coalesce(i.project_id, '__orphan__') as key, count(*) as count,
            sum(length(cast(e.payload as blob))) as payload_bytes
          from issue_events e left join issues i on i.id=e.issue_id
          group by key order by payload_bytes desc, count desc, key
        `),
        providers: distribution(sqlite, jsonDistribution("provider")),
        raw_methods: rawMethods as Array<DistributionRow & { retention_value: RetentionValue }>,
        top_issues: topIssues(sqlite, issueLimit),
        daily: distribution(sqlite, `
          select substr(created_at, 1, 10) as key, count(*) as count,
            sum(length(cast(payload as blob))) as payload_bytes
          from issue_events group by key order by key
        `),
        retention_value: retentionDistribution(eventTypes, rawMethods)
      },
      duplicates
    };
  } finally {
    sqlite.close();
  }
}

export function compareIssueEventsStorage(
  baseline: IssueEventsStorageAudit,
  current: IssueEventsStorageAudit
): IssueEventsStorageGrowth {
  const intervalSeconds = (Date.parse(current.snapshot.last_event_at) - Date.parse(baseline.snapshot.last_event_at)) / 1000;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("current snapshot must contain a later issue_events timestamp than baseline");
  }
  const intervalDays = intervalSeconds / 86400;
  return {
    interval_seconds: intervalSeconds,
    interval_days: rounded(intervalDays),
    event_count_delta: current.totals.event_count - baseline.totals.event_count,
    event_count_per_day: perDay(current.totals.event_count - baseline.totals.event_count, intervalDays),
    payload_bytes_delta: current.totals.payload_bytes - baseline.totals.payload_bytes,
    payload_bytes_per_day: perDay(current.totals.payload_bytes - baseline.totals.payload_bytes, intervalDays),
    raw_payload_bytes_delta: current.totals.raw_payload_bytes - baseline.totals.raw_payload_bytes,
    raw_payload_bytes_per_day: perDay(current.totals.raw_payload_bytes - baseline.totals.raw_payload_bytes, intervalDays),
    database_file_bytes_delta: current.snapshot.file_bytes - baseline.snapshot.file_bytes,
    database_file_bytes_per_day: perDay(current.snapshot.file_bytes - baseline.snapshot.file_bytes, intervalDays)
  };
}

export function classifyRetentionValue(eventType: string, rawMethod: string): RetentionValue {
  if (eventType !== "issue.log") return "R3_AUDIT";
  if (AUDIT_METHOD.test(rawMethod)) return "R3_AUDIT";
  if (DURABLE_METHOD.test(rawMethod)) return "R2_DURABLE";
  if (OPERATIONAL_METHOD.test(rawMethod)) return "R1_OPERATIONAL";
  return "REVIEW_REQUIRED";
}

function assertAuditSchema(sqlite: Database): void {
  const tables = new Set(sqlite.query<{ name: string }, []>(`
    select name from sqlite_master where type='table' and name in ('issues', 'issue_events')
  `).all().map((row) => row.name));
  if (!tables.has("issues") || !tables.has("issue_events")) {
    throw new Error("database must contain issues and issue_events tables");
  }
}

function distribution(sqlite: Database, sql: string): DistributionRow[] {
  return sqlite.query<KeyDistributionRow, []>(sql).all().map((row) => ({
    key: String(row.key || "unknown"),
    count: Number(row.count || 0),
    payload_bytes: Number(row.payload_bytes || 0)
  }));
}

function jsonDistribution(field: string): string {
  return `
    select case when json_valid(payload)
      then coalesce(nullif(json_extract(payload, '$.${field}'), ''), 'unknown')
      else 'invalid-json' end as key,
      count(*) as count, sum(length(cast(payload as blob))) as payload_bytes
    from issue_events where type='issue.log'
    group by key order by payload_bytes desc, count desc, key
  `;
}

function topIssues(sqlite: Database, limit: number): IssueDistributionRow[] {
  return sqlite.query<IssueDistributionRow, []>(`
    select e.issue_id, coalesce(i.project_id, '__orphan__') as project_id,
      cast(e.issue_id as text) as key, count(*) as count,
      sum(length(cast(e.payload as blob))) as payload_bytes
    from issue_events e left join issues i on i.id=e.issue_id
    group by e.issue_id, project_id order by payload_bytes desc, count desc, e.issue_id
    limit ${limit}
  `).all().map((row) => ({
    key: String(row.issue_id),
    issue_id: Number(row.issue_id),
    project_id: row.project_id,
    count: Number(row.count),
    payload_bytes: Number(row.payload_bytes)
  }));
}

function payloadFieldBytes(sqlite: Database): Record<string, number> {
  const fields = ["raw_payload", "text", "command", "payload", "error", "path", "status"];
  const projections = fields.map((field) =>
    `coalesce(sum(length(cast(json_extract(payload, '$.${field}') as blob))), 0) as ${field}`
  ).join(",\n");
  const row = requiredRow<Record<string, number>>(sqlite, `
    select ${projections}
    from issue_events where type='issue.log' and json_valid(payload)
  `);
  return Object.fromEntries(fields.map((field) => [field, Number(row[field] || 0)]));
}

function physicalIssueEventBytes(sqlite: Database): Map<string, number> {
  try {
    const rows = sqlite.query<DbStatRow, []>(`
      select name, sum(pgsize) as bytes from dbstat
      where name='issue_events' or name like 'idx_issue_events%'
      group by name
    `).all();
    return new Map(rows.map((row) => [row.name, Number(row.bytes || 0)]));
  } catch {
    return new Map();
  }
}

function duplicateSummary(sqlite: Database, totalPayloadBytes: number, limit: number): IssueEventsStorageAudit["duplicates"] {
  const fingerprints = new Map<string, DuplicateAggregate>();
  const rows = sqlite.query<DuplicateScanRow, []>(`
    select type, payload, length(cast(payload as blob)) as bytes,
      case when json_valid(payload) then coalesce(json_extract(payload, '$.provider'), 'unknown') else 'invalid-json' end as provider,
      case when json_valid(payload) then coalesce(json_extract(payload, '$.raw_method'), 'unknown') else 'invalid-json' end as raw_method
    from issue_events
  `).iterate();
  let rowCount = 0;
  for (const row of rows) {
    rowCount += 1;
    const fingerprint = createHash("sha256").update(row.type).update("\0").update(row.payload).digest("hex");
    const existing = fingerprints.get(fingerprint);
    if (existing) existing.count += 1;
    else fingerprints.set(fingerprint, {
      bytes: Number(row.bytes),
      count: 1,
      provider: row.provider,
      raw_method: row.raw_method,
      type: row.type
    });
  }
  const groups = [...fingerprints.entries()].flatMap(([fingerprint, row]) => {
    if (row.count <= 1) return [];
    return [{
      count: row.count,
      event_type: row.type,
      fingerprint,
      payload_bytes_each: row.bytes,
      provider: row.provider,
      raw_method: row.raw_method,
      redundant_payload_bytes: (row.count - 1) * row.bytes
    }];
  }).sort((left, right) => right.redundant_payload_bytes - left.redundant_payload_bytes);
  const duplicateRows = groups.reduce((sum, row) => sum + row.count - 1, 0);
  const redundantBytes = groups.reduce((sum, row) => sum + row.redundant_payload_bytes, 0);
  return {
    fingerprint_algorithm: "sha256(type + NUL + payload)",
    unique_type_payloads: rowCount - duplicateRows,
    duplicate_groups: groups.length,
    duplicate_rows: duplicateRows,
    redundant_payload_bytes: redundantBytes,
    redundant_payload_share: ratio(redundantBytes, totalPayloadBytes),
    top_groups: groups.slice(0, limit)
  };
}

function retentionDistribution(eventTypes: DistributionRow[], rawMethods: RawMethodRow[]): DistributionRow[] {
  const totals = new Map<RetentionValue, CountBytesRow>();
  for (const row of eventTypes.filter((item) => item.key !== "issue.log")) addRetention(totals, "R3_AUDIT", row);
  for (const row of rawMethods) addRetention(totals, row.retention_value ?? "REVIEW_REQUIRED", row);
  return [...totals.entries()].map(([key, row]) => ({ key, ...row }))
    .sort((left, right) => right.payload_bytes - left.payload_bytes);
}

function addRetention(totals: Map<RetentionValue, CountBytesRow>, key: RetentionValue, row: CountBytesRow): void {
  const current = totals.get(key) ?? { count: 0, payload_bytes: 0 };
  current.count += row.count;
  current.payload_bytes += row.payload_bytes;
  totals.set(key, current);
}

function requiredRow<T>(sqlite: Database, sql: string): T {
  const row = sqlite.query<T, []>(sql).get();
  if (!row) throw new Error("audit query returned no row");
  return row;
}

function scalar(sqlite: Database, sql: string): number {
  return Number(requiredRow<{ value: number }>(sqlite, sql).value || 0);
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100) throw new Error("audit limit must be an integer from 1 to 100");
  return value;
}

function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : rounded(numerator / denominator);
}

function perDay(delta: number, days: number): number {
  return rounded(delta / days);
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}
