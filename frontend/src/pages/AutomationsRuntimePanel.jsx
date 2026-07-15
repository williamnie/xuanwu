import { automationApi } from '../api/automation.js';
import { useEffect, useMemo, useState } from 'react';
import { Bot, RefreshCw, ToggleLeft, ToggleRight } from 'lucide-react';
import { PanelLoader } from '../components/TurtleLoader';
import { message } from '../store/toastStore';

export default function AutomationsRuntimePanel() {
  const [state, setState] = useState({ automations: [], error: '', loading: true, notice: '' });
  const counts = useMemo(() => statusCounts(state.automations), [state.automations]);

  useEffect(() => { loadAutomations(setState); }, []);

  return (
    <section className="glass-card" style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={() => loadAutomations(setState)} />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{state.error}</div>}
      {state.notice && <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>{state.notice}</div>}
      <AutomationSummary counts={counts} />
      <AutomationList automations={state.automations} loading={state.loading} setState={setState} />
    </section>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: '16px', justifyContent: 'space-between' }}>
      <div>
        <h2 style={{ alignItems: 'center', display: 'flex', fontSize: '1.1rem', fontWeight: 700, gap: '8px' }}>
          <Bot size={18} color="var(--primary)" /> Automations
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          展示 automation runner 的 enabled、last_status、next_run_at、error 与 backoff 诊断。
        </p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}

function AutomationSummary({ counts }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {['enabled', 'paused', 'success', 'running', 'error'].map((key) => (
        <span key={key} style={badgeStyle(key)}>{key}: {counts[key] || 0}</span>
      ))}
    </div>
  );
}

function AutomationList({ automations, loading, setState }) {
  if (loading && automations.length === 0) {
    return <PanelLoader label="正在整理 Automation 规则…" />;
  }
  if (automations.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>暂无 automation rules。</div>;
  }
  return (
    <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
      {automations.map((automation) => (
        <AutomationCard automation={automation} key={automation.id} setState={setState} />
      ))}
    </div>
  );
}

function AutomationCard({ automation, setState }) {
  const status = automation.last_status || (automation.enabled ? 'scheduled' : 'paused');
  return (
    <article style={cardStyle()}>
      <div style={{ alignItems: 'flex-start', display: 'flex', gap: '10px', justifyContent: 'space-between' }}>
        <div>
          <strong>{automation.name}</strong>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.74rem', marginTop: '3px' }}>
            #{automation.id} · {automation.trigger_type} · {automation.mode}
          </div>
        </div>
        <button className="btn btn-secondary" onClick={() => toggleAutomation(automation, setState)} type="button">
          {automation.enabled ? <ToggleRight size={15} /> : <ToggleLeft size={15} />}
          {automation.enabled ? '暂停' : '启用'}
        </button>
      </div>
      <MetaGrid automation={automation} status={status} />
      {automation.error && <div style={errorStyle()}>{automation.error}</div>}
      <StepList steps={automation.steps || []} />
    </article>
  );
}

function MetaGrid({ automation, status }) {
  return (
    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
      <Meta label="last_status" value={status} tone={status} />
      <Meta label="next_run_at" value={formatTime(automation.next_run_at)} />
      <Meta label="last_run_at" value={formatTime(automation.last_run_at)} />
      <Meta label="retry_count" value={String(automation.retry_count || 0)} tone={automation.retry_count ? 'error' : ''} />
    </div>
  );
}

function Meta({ label, tone = '', value }) {
  return (
    <div style={{ display: 'grid', gap: '3px' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{label}</span>
      <span style={{ color: statusColor(tone), fontSize: '0.84rem', fontWeight: 800, wordBreak: 'break-word' }}>
        {value || '—'}
      </span>
    </div>
  );
}

function StepList({ steps }) {
  if (!steps.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {steps.map((step) => <span key={step.idempotency_key || step.type} style={stepStyle()}>{step.type}</span>)}
    </div>
  );
}

function loadAutomations(setState) {
  setState((previous) => ({ ...previous, loading: true }));
  automationApi.getPiAutomations()
    .then((data) => setState({ automations: data.automations || [], error: '', loading: false, notice: '' }))
    .catch((error) => setState((previous) => ({
      ...previous,
      automations: error.status === 404 ? [] : previous.automations,
      error: error.status === 404 ? '' : error.message || '读取 automations 失败',
      loading: false,
      notice: error.status === 404 ? 'Automation API coming soon；当前 runtime 尚未启用 automation runner。' : ''
    })));
}

async function toggleAutomation(automation, setState) {
  try {
    await automationApi.updatePiAutomation(automation.id, { enabled: !automation.enabled });
    message.success(automation.enabled ? 'Automation 已暂停' : 'Automation 已启用');
    loadAutomations(setState);
  } catch (error) {
    message.error(error.message || '更新 automation 失败');
  }
}

function statusCounts(automations) {
  return automations.reduce((counts, automation) => {
    counts[automation.enabled ? 'enabled' : 'paused'] = (counts[automation.enabled ? 'enabled' : 'paused'] || 0) + 1;
    const status = automation.last_status || 'scheduled';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function formatTime(value) {
  return value ? String(value).replace('T', ' ').replace('.000Z', 'Z') : '';
}

function statusColor(status) {
  if (status === 'success' || status === 'enabled') return 'var(--success)';
  if (status === 'error') return 'var(--error)';
  if (status === 'running') return 'var(--primary)';
  return 'var(--text-primary)';
}

function cardStyle() {
  return {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: '14px',
    display: 'grid',
    gap: '12px',
    padding: '14px'
  };
}

function badgeStyle(key) {
  return {
    background: key === 'enabled' || key === 'success' ? 'var(--success-glow)' : 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: '999px',
    color: statusColor(key),
    fontSize: '0.76rem',
    fontWeight: 800,
    padding: '6px 10px'
  };
}

function errorStyle() {
  return {
    background: 'color-mix(in srgb, var(--error) 10%, transparent)',
    border: '1px solid color-mix(in srgb, var(--error) 24%, transparent)',
    borderRadius: '10px',
    color: 'var(--error)',
    fontSize: '0.82rem',
    padding: '8px 10px'
  };
}

function stepStyle() {
  return {
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-light)',
    borderRadius: '999px',
    color: 'var(--text-muted)',
    fontSize: '0.72rem',
    fontWeight: 700,
    padding: '4px 8px'
  };
}
