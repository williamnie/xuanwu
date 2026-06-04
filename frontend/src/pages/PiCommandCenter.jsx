import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Command, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import PiActionAuditPanel from './PiActionAuditPanel';
import PiDelegationsPanel from './PiDelegationsPanel';
import PiHeartbeatTimelinePanel from './PiHeartbeatTimelinePanel';
import PiPolicyEditorPanel from './PiPolicyEditorPanel';
import './PiCommandCenter.css';

const FRAMEWORK_SECTIONS = [];

export default function PiCommandCenter() {
  const state = useCommandCenterStatus();
  const cards = buildStatusCards(state.data);

  return (
    <div className="pi-command-center animate-fade-in">
      <Header state={state} />
      {state.error && <div className="pi-command-error" role="alert">{state.error}</div>}
      {state.loading && !state.data && <LoadingState />}
      <section className="pi-command-grid" aria-label="PI Command Center status cards">
        {cards.map(card => <StatusCard key={card.id} card={card} loading={state.loading && !state.data} />)}
      </section>
      <PiHeartbeatTimelinePanel />
      <PiActionAuditPanel onChanged={state.reload} variant="command-center" />
      <PiDelegationsPanel onChanged={state.reload} />
      <PiPolicyEditorPanel onChanged={state.reload} />
      <FrameworkPlaceholders />
    </div>
  );
}

function useCommandCenterStatus() {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const load = useCallback(async () => {
    setState(prev => ({ ...prev, error: '', loading: true }));
    try {
      setState({ data: await api.getPiCommandCenter(), error: '', loading: false });
    } catch (err) {
      setState(prev => ({ ...prev, error: err.message || '读取 PI Command Center 失败', loading: false }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

function Header({ state }) {
  return (
    <section className="pi-command-hero">
      <div>
        <span className="pi-command-kicker">PI OpenClaw P11.02</span>
        <h1>Command Center</h1>
        <p>Command Center：集中展示 mode、heartbeat、delegation 与 pending approvals，并管理授权窗口。</p>
      </div>
      <div className="pi-command-hero-actions">
        <span className="pi-command-micro">{generatedAt(state.data)}</span>
        <button className="pi-command-refresh" disabled={state.loading} onClick={state.reload} type="button">
          {state.loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>
    </section>
  );
}

function LoadingState() {
  return (
    <div className="pi-command-loading" aria-live="polite">
      <Loader2 size={16} className="spin-animation" />
      正在读取 PI Command Center 状态…
    </div>
  );
}

function StatusCard({ card, loading }) {
  const Icon = card.icon;
  return (
    <article className="pi-command-card pi-command-status-card">
      <div className="pi-command-status-icon"><Icon size={18} /></div>
      <span className="pi-command-label">{card.label}</span>
      <strong>{loading ? '—' : card.value}</strong>
      <p className="pi-command-card-detail">{loading ? 'loading' : card.detail}</p>
    </article>
  );
}

function FrameworkPlaceholders() {
  if (FRAMEWORK_SECTIONS.length === 0) return null;
  return (
    <section className="pi-command-module" aria-label="Command Center framework placeholders">
      <h2><Command size={18} /> Framework placeholders</h2>
      <div className="pi-command-placeholder-grid">
        {FRAMEWORK_SECTIONS.map(([title, description]) => (
          <article className="pi-command-placeholder" key={title}>
            <strong>{title}</strong>
            <p>{description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function buildStatusCards(data) {
  const overview = data?.overview || {};
  const heartbeat = heartbeatStatus(data?.heartbeat);
  return [
    { detail: 'manual / attended / delegated', icon: Command, id: 'mode', label: 'Mode', value: data?.mode || '—' },
    { detail: heartbeat.detail, icon: Activity, id: 'heartbeat', label: 'Heartbeat', value: heartbeat.value },
    { detail: `${numberText(overview.autonomous_projects)} autonomous projects`, icon: ShieldCheck, id: 'delegation', label: 'Delegation', value: `${numberText(overview.active_delegations)} active` },
    { detail: '需要人工确认的 PI action', icon: CheckCircle2, id: 'approvals', label: 'Pending approvals', value: numberText(overview.pending_approvals) },
  ];
}

function heartbeatStatus(heartbeat) {
  const latest = heartbeat?.latest_run || heartbeat?.recent_runs?.[0];
  const value = heartbeat?.status || latest?.status || 'idle';
  const when = latest?.finished_at || latest?.started_at || '';
  return { detail: when ? `latest ${formatTime(when)}` : '暂无 heartbeat run', value };
}

function generatedAt(data) {
  return data?.generated_at ? `Generated ${formatTime(data.generated_at)}` : 'Waiting for API';
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function numberText(value) {
  return String(Number(value || 0));
}
