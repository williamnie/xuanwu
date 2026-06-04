import type { RunnerDatabase } from "../database.ts";

export type NotificationRecord = {
  created_at: string;
  event: string;
  id: number;
  issue_id: number;
  message: string;
  payload: string;
  project_id: string;
  read_at: string;
  title: string;
};

export type NotificationWrite = {
  event: string;
  issueID?: number;
  message: string;
  payload: string;
  projectID: string;
  title: string;
};

export type NotificationListFilter = {
  projectID?: string;
  unreadOnly?: boolean;
};

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

export function createNotification(
  db: RunnerDatabase,
  input: NotificationWrite,
  now = new Date(),
  cooldownMs = DEFAULT_COOLDOWN_MS
): NotificationRecord | null {
  const record = normalizeWrite(input);
  const dedupeKey = notificationDedupeKey(record);
  if (insideCooldown(db, dedupeKey, now, cooldownMs)) return null;
  db.sqlite.run(
    `insert into notifications
      (event, project_id, issue_id, dedupe_key, title, message, payload, created_at, read_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, '')`,
    [record.event, record.projectID, record.issueID ?? 0, dedupeKey, record.title,
      record.message, record.payload, iso(now)]
  );
  return getNotification(db, lastInsertID(db));
}

export function listNotifications(
  db: RunnerDatabase,
  filter: NotificationListFilter = {}
): NotificationRecord[] {
  const projectID = cleanString(filter.projectID);
  const conditions: string[] = [];
  const args: string[] = [];
  if (projectID !== "") {
    conditions.push("project_id=?");
    args.push(projectID);
  }
  if (filter.unreadOnly) conditions.push("read_at=''");
  const where = conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "";
  return db.sqlite.query<NotificationRow, string[]>(`
    select id, event, project_id, issue_id, title, message, payload, created_at, read_at
    from notifications${where} order by created_at desc, id desc limit 100
  `).all(...args).map(mapNotification);
}

export function markNotificationRead(
  db: RunnerDatabase,
  id: number,
  now = new Date()
): NotificationRecord {
  const notificationID = positiveInteger(id);
  db.sqlite.run(
    "update notifications set read_at=case when read_at='' then ? else read_at end where id=?",
    [iso(now), notificationID]
  );
  return getNotification(db, notificationID);
}

type NotificationRow = {
  created_at: unknown;
  event: unknown;
  id: unknown;
  issue_id: unknown;
  message: unknown;
  payload: unknown;
  project_id: unknown;
  read_at: unknown;
  title: unknown;
};

function insideCooldown(db: RunnerDatabase, dedupeKey: string, now: Date, cooldownMs: number): boolean {
  const row = db.sqlite.query<{ created_at: string }, [string]>(
    "select created_at from notifications where dedupe_key=? order by created_at desc, id desc limit 1"
  ).get(dedupeKey);
  if (!row?.created_at) return false;
  return now.getTime() - Date.parse(row.created_at) < cooldownMs;
}

function getNotification(db: RunnerDatabase, id: number): NotificationRecord {
  const row = db.sqlite.query<NotificationRow, [number]>(
    `select id, event, project_id, issue_id, title, message, payload, created_at, read_at
     from notifications where id=?`
  ).get(id);
  if (!row) throw new Error("notification not found");
  return mapNotification(row);
}

function normalizeWrite(input: NotificationWrite): Required<NotificationWrite> {
  return {
    event: cleanString(input.event),
    issueID: Number.isSafeInteger(input.issueID) ? input.issueID : 0,
    message: cleanString(input.message),
    payload: cleanString(input.payload) || "{}",
    projectID: cleanString(input.projectID),
    title: cleanString(input.title)
  };
}

function notificationDedupeKey(record: Required<NotificationWrite>): string {
  return [record.event, record.projectID, String(record.issueID)].join(":");
}

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: positiveInteger(row.id),
    event: requiredString(row.event),
    project_id: requiredString(row.project_id),
    issue_id: integerValue(row.issue_id),
    title: optionalString(row.title),
    message: optionalString(row.message),
    payload: optionalString(row.payload, "{}"),
    created_at: requiredString(row.created_at),
    read_at: optionalString(row.read_at)
  };
}

function lastInsertID(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  return positiveInteger(row?.id);
}

function positiveInteger(value: unknown): number {
  const number = integerValue(value);
  if (number <= 0) throw new Error("id must be positive");
  return number;
}

function integerValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("expected integer row value");
  return value;
}

function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (text === "") throw new Error("expected non-empty string row value");
  return text;
}

function optionalString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function iso(now: Date): string {
  return now.toISOString();
}
