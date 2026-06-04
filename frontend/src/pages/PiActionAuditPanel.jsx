import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, GitBranch, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { api } from '../api/client';
import { piActionGateApi } from '../api/piActionGateClient';
import { message } from '../store/toastStore';
import { shortId } from './piChatState';
import './PiActionAuditPanel.css';

const AUDIT_LIMIT = 36;
const SNOOZE_MS = 60 * 60 * 1000;

export default function PiActionAuditPanel({ onChanged, variant = 'sidebar' }) {
  const audit = usePiActionAudit(onChanged);
  const className = `pi-action-audit-panel ${variant === 'command-center' ? 'command-center' : ''}`.trim();
  return (
    <section className={className} aria-label="PI pending approvals and audit timeline">
      <PanelHeader audit={audit} variant={variant} />
      {audit.error && <div className="pi-action-audit-error">{audit.error}</div>}
      <PendingApprovals audit={audit} />
      <AuditTimeline events={audit.events} loading={audit.loading} />
    </section>
  );
}

function usePiActionAudit(onChanged) {
  const approvals = useApprovalData();
  const errors = useActionErrors();
  const decisions = useDecisionState(approvals, errors, onChanged);
  return {
    ...approvals,
    ...decisions,
    actionErrors: errors.actionErrors
  };
}

function useApprovalData() {
  const [events, setEvents] = useState([]);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [snoozeTimes, setSnoozeTimes] = useState({});
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pendingActions, auditEvents] = await Promise.all([
        piActionGateApi.pendingActions(),
        piActionGateApi.auditEvents(),
      ]);
      const normalizedActions = Array.isArray(pendingActions) ? pendingActions : [];
      setActions(normalizedActions);
      setSnoozeTimes((current) => mergeSnoozeTimes(current, normalizedActions));
      setEvents(Array.isArray(auditEvents) ? auditEvents.slice(-AUDIT_LIMIT).reverse() : []);
      setError('');
    } catch (err) {
      setError(err.message || '读取 PI audit timeline 失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => api.subscribeToEvents((event) => {
    if (String(event?.type || '').startsWith('pi.action_')) load();
  }), [load]);
  const updateSnoozeTime = useCallback((id, value) => {
    setSnoozeTimes((current) => ({ ...current, [id]: value }));
  }, []);
  return { actions, error, events, load, loading, snoozeTimes, updateSnoozeTime };
}

function useActionErrors() {
  const [actionErrors, setActionErrors] = useState({});
  const clearActionError = useCallback((id) => {
    setActionErrors((current) => removeKey(current, id));
  }, []);
  const setActionError = useCallback((id, errorText) => {
    setActionErrors((current) => ({ ...current, [id]: errorText }));
  }, []);
  return { actionErrors, clearActionError, setActionError };
}

function useDecisionState(approvals, errors, onChanged) {
  const [drafts, setDrafts] = useState({});
  const [submitting, setSubmitting] = useState('');
  const decide = useCallback(async (id, decision) => {
    setSubmitting(`${id}:${decision}`);
    errors.clearActionError(id);
    try {
      await runDecision(id, decision, drafts[id] || '', approvals.snoozeTimes[id] || '');
      setDrafts((current) => ({ ...current, [id]: '' }));
      message.success('PI action decision 已记录');
      await approvals.load();
      onChanged?.();
    } catch (err) {
      const errorText = err.message || '提交 PI action decision 失败';
      errors.setActionError(id, errorText);
      message.error(errorText);
    } finally {
      setSubmitting('');
    }
  }, [approvals, drafts, errors, onChanged]);
  const updateDraft = useCallback((id, value) => {
    setDrafts((current) => ({ ...current, [id]: value }));
  }, []);
  return { decide, drafts, submitting, updateDraft };
}

function PanelHeader({ audit, variant }) {
  const isCommandCenter = variant === 'command-center';
  return (
    <div className="pi-action-audit-header">
      <div>
        <span>{isCommandCenter ? 'Approvals' : 'Action Gate'}</span>
        <strong>{audit.actions.length} pending</strong>
        {isCommandCenter && <p>Review rationale, risk and scope before approving PI actions.</p>}
      </div>
      <button className="pi-action-audit-refresh" onClick={audit.load} disabled={audit.loading} title="刷新 PI action gate">
        {audit.loading ? <Loader2 size={13} className="spin-animation" /> : <GitBranch size={13} />}
      </button>
    </div>
  );
}

function PendingApprovals({ audit }) {
  if (audit.actions.length === 0) {
    return <div className="pi-action-audit-empty">暂无待审批动作；新的 confirm/high 动作会进入这里。</div>;
  }
  return (
    <div className="pi-action-approval-list">
      {audit.actions.map((action) => (
        <ApprovalCard key={action.id} action={action} audit={audit} />
      ))}
    </div>
  );
}

function ApprovalCard({ action, audit }) {
  const draft = audit.drafts[action.id] || '';
  const scopeItems = actionScopeItems(action);
  return (
    <article className="pi-action-approval-card">
      <div className="pi-action-card-topline">
        <span className={`pi-action-risk ${action.risk_level || 'low'}`}>{action.risk_level || 'low'}</span>
        <code>{action.action_type}</code>
      </div>
      <div className="pi-action-rationale">
        <span>Rationale</span>
        <p>{action.rationale || action.gate_reason || 'PI 提议执行该动作，等待用户审批。'}</p>
      </div>
      <div className="pi-action-scope">
        <span>Scope</span>
        <div>{scopeItems.map((item) => <code key={item}>{item}</code>)}</div>
      </div>
      <label className="pi-action-note-field">
        <span>Decision note</span>
        <textarea
          value={draft}
          onChange={(event) => audit.updateDraft(action.id, event.target.value)}
          placeholder="reject / request changes / snooze 的说明，例如补充验证方式或缩小范围..."
        />
      </label>
      <label className="pi-action-snooze-field">
        <span>Snooze until</span>
        <input
          type="datetime-local"
          value={audit.snoozeTimes[action.id] || ''}
          onChange={(event) => audit.updateSnoozeTime(action.id, event.target.value)}
        />
      </label>
      {audit.actionErrors[action.id] && <div className="pi-action-card-error" role="alert">{audit.actionErrors[action.id]}</div>}
      <div className="pi-action-decision-row">
        <DecisionButton action={action} audit={audit} decision="approve" icon={<CheckCircle2 size={13} />} label="Approve" />
        <DecisionButton action={action} audit={audit} decision="request_changes" icon={<ShieldAlert size={13} />} label="Changes" />
        <DecisionButton action={action} audit={audit} decision="snooze" icon={<Clock3 size={13} />} label="Snooze" />
        <DecisionButton action={action} audit={audit} decision="reject" icon={<XCircle size={13} />} label="Reject" />
      </div>
    </article>
  );
}

function DecisionButton({ action, audit, decision, icon, label }) {
  const busy = audit.submitting === `${action.id}:${decision}`;
  return (
    <button type="button" disabled={Boolean(audit.submitting)} onClick={() => audit.decide(action.id, decision)}>
      {busy ? <Loader2 size={13} className="spin-animation" /> : icon}
      {label}
    </button>
  );
}

function AuditTimeline({ events, loading }) {
  const visibleEvents = useMemo(() => events.slice(0, AUDIT_LIMIT), [events]);
  return (
    <div className="pi-action-timeline">
      <div className="pi-action-timeline-title">Audit timeline {loading && <Loader2 size={12} className="spin-animation" />}</div>
      {visibleEvents.length === 0 ? <div className="pi-action-audit-empty">暂无 audit record。</div> : visibleEvents.map((event) => (
        <TimelineEvent key={`${event.id}-${event.event_type}`} event={event} />
      ))}
    </div>
  );
}

function TimelineEvent({ event }) {
  return (
    <article className="pi-action-timeline-event">
      <div className="pi-action-timeline-dot" />
      <div className="pi-action-timeline-body">
        <div className="pi-action-timeline-meta">
          <strong>{eventLabel(event)}</strong>
          <span>{shortId(event.action_id)}</span>
        </div>
        <p>{event.reason || event.error || summarizeJson(event.result_json) || summarizeJson(event.payload_json)}</p>
        <small>{event.actor || 'system'} · {formatTime(event.created_at)}</small>
      </div>
    </article>
  );
}

async function runDecision(id, decision, draft, snoozeTime) {
  if (decision === 'approve') return piActionGateApi.approve(id);
  if (decision === 'reject') return piActionGateApi.reject(id);
  if (decision === 'request_changes') return piActionGateApi.requestChanges(id, draft.trim() || '需要 PI 修改动作说明');
  return piActionGateApi.snooze(id, draft.trim() || '稍后再审', isoFromLocalInput(snoozeTime));
}

function eventLabel(event) {
  const decision = event.decision ? ` · ${event.decision}` : '';
  return `${String(event.event_type || 'audit').replaceAll('_', ' ')}${decision}`;
}

function summarizeJson(text) {
  try {
    const value = JSON.parse(text || '{}');
    if (value.action_type) return `${value.action_type} ${value.status || ''}`.trim();
    if (value.error) return value.error;
    return '';
  } catch {
    return '';
  }
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function mergeSnoozeTimes(current, actions) {
  return Object.fromEntries(actions.map((action) => [
    action.id,
    current[action.id] || localInputFromDate(action.snoozed_until || new Date(Date.now() + SNOOZE_MS))
  ]));
}

function actionScopeItems(action) {
  const payload = parseJsonObject(action.payload_json);
  const items = [
    action.project_id ? `project:${action.project_id}` : '',
    action.issue_id ? `issue:#${action.issue_id}` : '',
    payload.issue_id ? `payload issue:#${payload.issue_id}` : '',
    payload.target_issue_id ? `target:#${payload.target_issue_id}` : '',
    payload.session_key ? `session:${payload.session_key}` : '',
    payload.goal_id ? `goal:${payload.goal_id}` : '',
    action.delegation_id ? `delegation:${shortId(action.delegation_id)}` : '',
    action.heartbeat_id ? `heartbeat:${shortId(action.heartbeat_id)}` : '',
    action.conversation_id ? `conversation:${shortId(action.conversation_id)}` : '',
    action.source ? `source:${action.source}` : '',
  ].filter(Boolean);
  return items.length > 0 ? items : ['global'];
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function isoFromLocalInput(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) throw new Error('请选择合法的 snooze 时间');
  return date.toISOString();
}

function localInputFromDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const validDate = Number.isNaN(date.getTime()) ? new Date(Date.now() + SNOOZE_MS) : date;
  const offsetMs = validDate.getTimezoneOffset() * 60 * 1000;
  return new Date(validDate.getTime() - offsetMs).toISOString().slice(0, 16);
}

function removeKey(record, key) {
  return Object.fromEntries(Object.entries(record).filter(([itemKey]) => itemKey !== key));
}
