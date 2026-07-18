export const AUTOMATION_STATUSES = ['active', 'paused', 'draft', 'archived'];
export const AUTOMATION_TRIGGERS = ['cron', 'continuous', 'manual', 'webhook'];

export function filterAutomations(items, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items;
  return items.filter(item => [item.name, item.id, item.workflow_ref, item.owner?.project_id]
    .some(value => String(value || '').toLowerCase().includes(needle)));
}

export function emptyAutomationForm(projectId = '') {
  return {
    id: '', mode: 'propose', name: '', next_run_at: '', permission_policy_ref: projectId ? `project-policy:${projectId}` : '',
    project_id: projectId, status: 'active', trigger_expression: '0 9 * * 1-5', trigger_event_type: 'issue.updated',
    trigger_interval: '300', trigger_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', trigger_type: 'cron',
    workflow_ref: 'workflow:investigate@1'
  };
}

export function automationForm(detail) {
  const automation = detail?.automation || {};
  const trigger = detail?.trigger || {};
  return {
    ...emptyAutomationForm(automation.owner?.project_id || ''),
    id: automation.id || '', mode: automation.mode || 'propose', name: automation.name || '', next_run_at: automation.next_run_at || '',
    permission_policy_ref: automation.permission_policy_ref || '', status: automation.status || 'draft',
    trigger_expression: trigger.config?.expression || '0 9 * * 1-5', trigger_event_type: trigger.config?.event_type || 'issue.updated',
    trigger_interval: String(trigger.config?.poll_interval_seconds || 300), trigger_timezone: trigger.config?.timezone || 'UTC',
    trigger_type: trigger.type || 'manual', workflow_ref: automation.workflow_ref || 'workflow:investigate@1'
  };
}

export function automationCreatePayload(form) {
  return {
    id: automationSlug(form.id || form.name), mode: form.mode, name: form.name.trim(), next_run_at: form.next_run_at || undefined,
    permission_policy_ref: form.permission_policy_ref.trim() || undefined, project_id: form.project_id, status: form.status,
    trigger: triggerPayload(form), workflow_ref: form.workflow_ref.trim()
  };
}

export function automationUpdatePayload(form, revision) {
  return {
    expected_revision: revision, mode: form.mode, name: form.name.trim(), next_run_at: form.next_run_at || null,
    permission_policy_ref: form.permission_policy_ref.trim(), workflow_ref: form.workflow_ref.trim()
  };
}

export function triggerUpdatePayload(form, revision) {
  return { expected_revision: revision, next_run_at: form.next_run_at || undefined, trigger: triggerPayload(form) };
}

export function triggerPayload(form) {
  if (form.trigger_type === 'cron') return { type: 'cron', config: { expression: form.trigger_expression.trim(), timezone: form.trigger_timezone.trim() } };
  if (form.trigger_type === 'continuous') return { type: 'continuous', config: { poll_interval_seconds: Number(form.trigger_interval) } };
  if (form.trigger_type === 'webhook') return { type: 'webhook', config: { event_type: form.trigger_event_type.trim() } };
  return { type: 'manual', config: {} };
}

export function triggerChanged(form, detail) {
  return JSON.stringify(triggerPayload(form)) !== JSON.stringify({ type: detail?.trigger?.type, config: detail?.trigger?.config || {} });
}

export function automationSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/^automation:/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
