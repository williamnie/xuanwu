import { useCallback, useEffect, useState } from 'react';
import { Activity, Bot, CheckCircle2, Command, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import PiActionAuditPanel from './PiActionAuditPanel';
import PiDelegationsPanel from './PiDelegationsPanel';
import PiHeartbeatTimelinePanel from './PiHeartbeatTimelinePanel';
import PiPolicyEditorPanel from './PiPolicyEditorPanel';
import PiReportsPanel from './PiReportsPanel';
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
      <section className="pi-command-grid" aria-label="PI 控制台状态卡片">
        {cards.map(card => <StatusCard key={card.id} card={card} loading={state.loading && !state.data} />)}
      </section>
      <PiHeartbeatTimelinePanel />
      <PiReportsPanel />
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
      setState(prev => ({ ...prev, error: err.message || '读取 PI 控制台失败', loading: false }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

function Header({ state }) {
  const overview = state.data?.overview || {};
  const heartbeat = heartbeatStatus(state.data?.heartbeat);
  const mode = modeText(state.data?.mode);
  return (
    <section className="pi-command-hero">
      <div>
        <span className="pi-command-kicker">PI 托管控制台</span>
        <h1>自动执行与审批中心</h1>
        <p>查看自动执行状态、处理高风险动作审批，并管理委托窗口与执行策略。</p>
        <div className="pi-command-hero-summary" aria-label="当前需要处理的事项">
          <span>待审批 {numberText(overview.pending_approvals)} 项</span>
          <span>当前模式：{mode}</span>
          <span>最近自动检查：{heartbeat.detail}</span>
        </div>
      </div>
      <div className="pi-command-hero-actions">
        <span className="pi-command-micro">{generatedAt(state.data)}</span>
        <button className="pi-command-refresh" disabled={state.loading} onClick={state.reload} type="button">
          {state.loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />}
          刷新状态
        </button>
      </div>
    </section>
  );
}

function LoadingState() {
  return (
    <div className="pi-command-loading" aria-live="polite">
      <Loader2 size={16} className="spin-animation" />
      正在读取 PI 控制台状态…
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
      <p className="pi-command-card-detail">{loading ? '加载中' : card.detail}</p>
    </article>
  );
}

function FrameworkPlaceholders() {
  if (FRAMEWORK_SECTIONS.length === 0) return null;
  return (
    <section className="pi-command-module" aria-label="PI 控制台框架占位">
      <h2><Command size={18} /> 控制台后续模块</h2>
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
    { detail: modeDetail(data?.mode), icon: Command, id: 'mode', label: '当前模式', value: modeText(data?.mode) },
    { detail: heartbeat.detail, icon: Activity, id: 'heartbeat', label: '自动检查', value: heartbeat.value },
    { detail: `${numberText(overview.autonomous_projects)} 个项目已开启自动执行`, icon: ShieldCheck, id: 'delegation', label: '委托窗口', value: `${numberText(overview.active_delegations)} 个生效中` },
    { detail: '需要人工确认的高风险动作', icon: CheckCircle2, id: 'approvals', label: '待我审批', value: `${numberText(overview.pending_approvals)} 项` },
    { detail: supervisorDetail(data?.supervisor), icon: Bot, id: 'supervisor', label: '自动恢复', value: `${numberText(data?.supervisor?.recovery_actions)} 次` },
  ];
}

function supervisorDetail(supervisor = {}) {
  return `${numberText(supervisor.rate_limit_waits)} 次限流等待 · ${numberText(supervisor.needs_user_escalations)} 次需人工处理`;
}

function heartbeatStatus(heartbeat) {
  const latest = heartbeat?.latest_run || heartbeat?.recent_runs?.[0];
  const value = statusText(heartbeat?.status || latest?.status || 'idle');
  const when = latest?.finished_at || latest?.started_at || '';
  return { detail: when ? formatTime(when) : '暂无记录', value };
}

function generatedAt(data) {
  return data?.generated_at ? `状态更新于 ${formatTime(data.generated_at)}` : '等待服务状态';
}

function modeText(mode) {
  const labels = { attended: '辅助模式', delegated: '托管模式', manual: '手动模式' };
  return labels[mode] || '未配置';
}

function modeDetail(mode) {
  const details = {
    attended: 'PI 会给出建议，关键动作仍由人工确认',
    delegated: '已授权在委托窗口内自动推进',
    manual: '不会自动执行，需要人工触发',
  };
  return details[mode] || '等待 PI 策略初始化';
}

function statusText(status) {
  const labels = { cancelled: '已取消', completed: '正常', failed: '检查失败', idle: '空闲', skipped: '已跳过', success: '正常', running: '检查中' };
  return labels[status] || status || '未知';
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function numberText(value) {
  return String(Number(value || 0));
}
