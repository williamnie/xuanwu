const PROJECT_FIELDS = [
  'id',
  'name',
  'cwd',
  'provider',
  'provider_config_json',
  'auto_run',
  'model',
  'approval_policy',
  'sandbox',
  'default_mcp_policy',
  'sort_order',
  'created_at',
  'updated_at',
  'loop_status',
  'hold',
];

const GUARDIAN_ALERT_FIELDS = [
  'id',
  'alert_type',
  'severity',
  'status',
  'project_id',
  'issue_id',
  'run_group_id',
  'message',
  'ui_visible',
  'direct_feishu_state',
  'direct_feishu_error',
  'next_retry_at',
  'retry_count',
  'max_retry_count',
  'watchdog_seen_at',
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

export function sameProjects(current, next) {
  return sameListByFields(current, next, PROJECT_FIELDS);
}

export function sameGuardianAlerts(current, next) {
  return sameListByFields(current, next, GUARDIAN_ALERT_FIELDS);
}
