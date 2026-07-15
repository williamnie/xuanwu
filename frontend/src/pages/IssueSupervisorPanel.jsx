import { Bot } from 'lucide-react';

export default function IssueSupervisorPanel({ supervisor }) {
  const latest = supervisor?.latest || {};
  const decision = latest.pi_decision || {};
  const retry = supervisor?.retry_after;
  const history = Array.isArray(supervisor?.recovery_history) ? supervisor.recovery_history.slice(0, 6) : [];
  const hasSignal = Boolean(
    latest.diagnosis_code || decision.decision || retry || latest.provider_error?.raw_summary || history.length
  );
  return (
    <section className="glass-card issue-supervisor-panel">
      <div className="issue-supervisor-header">
        <div>
          <h3><Bot size={18} color="var(--primary)" /> Supervisor</h3>
          <p>只读展示最近一次 supervisor 判断、等待窗口和恢复审计；不触发恢复动作。</p>
        </div>
        <span className={`triage-readiness-badge ${supervisorBadgeClass(latest.diagnosis_code, decision.decision)}`}>
          {decision.decision || latest.diagnosis_code || 'observing'}
        </span>
      </div>
      {!hasSignal ? (
        <p className="issue-supervisor-empty">暂无 supervisor signal / decision / recovery 记录。</p>
      ) : (
        <>
          <SupervisorField label="Diagnosis" value={latest.diagnosis_code} />
          <SupervisorField label="Last provider error" value={providerErrorText(latest.provider_error)} mono />
          {retry && <RetryAfterCard retry={retry} />}
          <SupervisorField label="Decision rationale" value={decision.rationale} />
          <SupervisorField label="Executed recovery message" value={latest.executed_recovery_message} mono />
          <SupervisorHistory events={history} />
        </>
      )}
    </section>
  );
}

function RetryAfterCard({ retry }) {
  return (
    <div className="issue-supervisor-retry">
      <strong>429 / retry-after wait</strong>
      <span>{retry.remaining_seconds > 0 ? `${formatDuration(retry.remaining_seconds)} 后可恢复` : '等待窗口已到，可重新评估'}</span>
      <code>{retry.at}</code>
      <p>来源证据：{retry.source || 'unknown'}{retry.reason ? ` · ${retry.reason}` : ''}</p>
    </div>
  );
}

function SupervisorHistory({ events }) {
  if (events.length === 0) return null;
  return (
    <div className="issue-supervisor-history">
      <span>Recovery history</span>
      {events.map(event => (
        <article key={event.id || `${event.created_at}-${event.event_type}`}>
          <strong>{event.event_type}{event.action_type ? ` · ${event.action_type}` : ''}</strong>
          <time>{formatDateTime(event.created_at)}</time>
          <p>{event.message || event.diagnosis_code || event.decision || 'recorded'}</p>
        </article>
      ))}
    </div>
  );
}

function SupervisorField({ label, value, mono = false }) {
  if (!value) return null;
  return (
    <div className="issue-supervisor-field">
      <span>{label}</span>
      <p className={mono ? 'mono' : ''}>{value}</p>
    </div>
  );
}

function providerErrorText(error = {}) {
  const parts = [
    error.status_code ? `HTTP ${error.status_code}` : '',
    error.category,
    error.raw_summary,
    error.retry_after_at ? `retry_after_at=${error.retry_after_at}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function supervisorBadgeClass(diagnosis, decision) {
  if (decision === 'needs_user' || decision === 'blocked') return 'warning';
  if (String(diagnosis || '').includes('rate_limit')) return 'discussing';
  if (decision === 'resume_session') return 'ready';
  return 'discussing';
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (total <= 0) return '0s';
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes <= 0) return `${rest}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${minutes}m ${rest}s`;
}

function formatDateTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
