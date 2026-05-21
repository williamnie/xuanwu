const PROJECT_FIELDS = [
  'id',
  'name',
  'cwd',
  'auto_run',
  'model',
  'approval_policy',
  'sandbox',
  'created_at',
  'updated_at',
  'loop_status',
];

const ISSUE_FIELDS = [
  'id',
  'project_id',
  'title',
  'description',
  'status',
  'priority',
  'codex_thread_id',
  'codex_turn_id',
  'attempt_count',
  'error',
  'created_at',
  'updated_at',
];

export const RECONCILE_INTERVAL_MS = 30_000;

function fieldSignature(item, fields) {
  return fields.map(field => String(item?.[field] ?? '')).join('\u001f');
}

function sameRecordByFields(current, next, fields) {
  if (current === next) return true;
  if (!current || !next) return current === next;
  return fieldSignature(current, fields) === fieldSignature(next, fields);
}

function sameListByFields(current = [], next = [], fields) {
  if (current === next) return true;
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  if (current.length !== next.length) return false;

  return current.every((item, index) => sameRecordByFields(item, next[index], fields));
}

export function sameProject(current, next) {
  return sameRecordByFields(current, next, PROJECT_FIELDS);
}

export function sameIssue(current, next) {
  return sameRecordByFields(current, next, ISSUE_FIELDS);
}

export function sameProjects(current, next) {
  return sameListByFields(current, next, PROJECT_FIELDS);
}

export function sameIssues(current, next) {
  return sameListByFields(current, next, ISSUE_FIELDS);
}

function eventIdentity(event, index) {
  if (!event) return '';
  const issueId = event.issue_id ?? event.issueId ?? '';
  return [event.id ?? `pending-${index}`, issueId, event.type, event.created_at ?? ''].join('\u001f');
}

export function sameIssueEvents(current = [], next = []) {
  if (current === next) return true;
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  if (current.length !== next.length) return false;

  return current.every((event, index) => eventIdentity(event, index) === eventIdentity(next[index], index));
}

export function hasIssueEvent(events, candidate) {
  if (!candidate) return true;
  if (candidate.id) {
    return events.some(event => event.id === candidate.id);
  }
  const candidateKey = eventIdentity(candidate, events.length);
  return events.some((event, index) => eventIdentity(event, index) === candidateKey);
}

export function issueEventKey(event, fallbackIndex = 0) {
  return eventIdentity(event, fallbackIndex);
}
