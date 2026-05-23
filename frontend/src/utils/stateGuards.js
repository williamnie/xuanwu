const PROJECT_FIELDS = [
  'id',
  'name',
  'cwd',
  'auto_run',
  'model',
  'approval_policy',
  'sandbox',
  'sort_order',
  'created_at',
  'updated_at',
  'loop_status',
  'hold',
];

const ISSUE_FIELDS = [
  'id',
  'project_id',
  'title',
  'description',
  'status',
  'priority',
  'template_id',
  'prompt_template',
  'codex_thread_id',
  'codex_turn_id',
  'attempt_count',
  'error',
  'created_at',
  'updated_at',
];

const ISSUE_TEMPLATE_FIELDS = [
  'id',
  'name',
  'content',
  'is_default',
  'created_at',
  'updated_at',
];

const CRON_TASK_FIELDS = [
  'id',
  'name',
  'project_id',
  'action',
  'mode',
  'time_of_day',
  'next_run_at',
  'last_run_at',
  'status',
  'run_count',
  'error',
  'created_at',
  'updated_at',
];

export const RECONCILE_INTERVAL_MS = 30_000;

function fieldSignature(item, fields) {
  return fields.map(field => fieldValueSignature(item?.[field])).join('\u001f');
}

function fieldValueSignature(value) {
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value ?? '');
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

export function sameIssueTemplates(current, next) {
  return sameListByFields(current, next, ISSUE_TEMPLATE_FIELDS);
}

export function sameCronTasks(current, next) {
  return sameListByFields(current, next, CRON_TASK_FIELDS);
}

function eventIdentity(event, index) {
  if (!event) return '';
  const issueId = event.issue_id ?? event.issueId ?? '';
  const pendingKey = [
    'pending',
    issueId,
    event.type ?? '',
    event.status ?? '',
    event.error ?? '',
    event.text ?? '',
    event.payload ?? '',
    event.created_at ?? '',
    index,
  ].join('\u001f');
  return [event.id ?? pendingKey, issueId, event.type, event.created_at ?? ''].join('\u001f');
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
  const issueId = candidate.issue_id ?? candidate.issueId ?? '';
  return events.some(event => {
    const eventIssueId = event.issue_id ?? event.issueId ?? '';
    return !event.id &&
      eventIssueId === issueId &&
      event.type === candidate.type &&
      event.status === candidate.status &&
      event.error === candidate.error &&
      event.text === candidate.text &&
      event.payload === candidate.payload;
  });
}

export function issueEventKey(event, fallbackIndex = 0) {
  return eventIdentity(event, fallbackIndex);
}
