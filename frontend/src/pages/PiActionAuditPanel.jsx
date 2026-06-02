import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, GitBranch, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { api } from '../api/client';
import { piActionGateApi } from '../api/piActionGateClient';
import { message } from '../store/toastStore';
import { shortId } from './piChatState';
import './PiActionAuditPanel.css';

const AUDIT_LIMIT = 36;
const SNOOZE_MS = 60 * 60 * 1000;

export default function PiActionAuditPanel() {
  const audit = usePiActionAudit();
  return (
    <section className="pi-action-audit-panel" aria-label="PI Action Gate and audit timeline">
      <PanelHeader audit={audit} />
      {audit.error && <div className="pi-action-audit-error">{audit.error}</div>}
      <PendingApprovals audit={audit} />
      <AuditTimeline events={audit.events} loading={audit.loading} />
    </section>
  );
}

function usePiActionAudit() {
  const [actions, setActions] = useState([]);
  const [events, setEvents] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pendingActions, auditEvents] = await Promise.all([
        piActionGateApi.pendingActions(),
        piActionGateApi.auditEvents(),
      ]);
      setActions(Array.isArray(pendingActions) ? pendingActions : []);
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

  const decide = useCallback(async (id, decision) => {
    setSubmitting(`${id}:${decision}`);
    try {
      await runDecision(id, decision, drafts[id] || '');
      setDrafts((current) => ({ ...current, [id]: '' }));
      message.success('PI action decision 已记录');
      await load();
    } catch (err) {
      message.error(err.message || '提交 PI action decision 失败');
    } finally {
      setSubmitting('');
    }
  }, [drafts, load]);

  const updateDraft = useCallback((id, value) => {
    setDrafts((current) => ({ ...current, [id]: value }));
  }, []);

  return { actions, decide, drafts, error, events, load, loading, submitting, updateDraft };
}

function PanelHeader({ audit }) {
  return (
    <div className="pi-action-audit-header">
      <div>
        <span>Action Gate</span>
        <strong>{audit.actions.length} pending</strong>
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
  return (
    <article className="pi-action-approval-card">
      <div className="pi-action-card-topline">
        <span className={`pi-action-risk ${action.risk_level || 'low'}`}>{action.risk_level || 'low'}</span>
        <code>{action.action_type}</code>
      </div>
      <p>{action.rationale || action.gate_reason || 'PI 提议执行该动作，等待用户审批。'}</p>
      <textarea
        value={draft}
        onChange={(event) => audit.updateDraft(action.id, event.target.value)}
        placeholder="request changes 的说明，例如补充验证方式或缩小范围..."
      />
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

async function runDecision(id, decision, draft) {
  if (decision === 'approve') return piActionGateApi.approve(id);
  if (decision === 'reject') return piActionGateApi.reject(id);
  if (decision === 'request_changes') return piActionGateApi.requestChanges(id, draft.trim() || '需要 PI 修改动作说明');
  return piActionGateApi.snooze(id, draft.trim() || '稍后再审', new Date(Date.now() + SNOOZE_MS).toISOString());
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
