import { useCallback, useEffect, useState } from 'react';
import { Activity, Bot, CheckCircle2, Command, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import PiActionAuditPanel from './PiActionAuditPanel';
import PiDelegationsPanel from './PiDelegationsPanel';
import PiHeartbeatTimelinePanel from './PiHeartbeatTimelinePanel';
import PiPolicyEditorPanel from './PiPolicyEditorPanel';
import PiReportsPanel from './PiReportsPanel';
import { COMMAND_CENTER_TERMS, modeLabel, statusLabel } from './piCommandCenterTerms';
import { approvalCalloutState, pendingApprovalCount } from './piCommandCenterState';
import './PiCommandCenter.css';
import './PiCommandCenter.layout.css';

const FRAMEWORK_SECTIONS = [];
const DETAIL_MODULES = [
  ['timeline', '自动检查时间线', '追踪最近运行证据'],
  ['reports', '恢复报告', '查看自动恢复汇总'],
  ['delegations', '委托窗口', '创建或暂停授权窗口'],
  ['policy', '执行策略', '调整项目默认规则'],
];

export default function PiCommandCenter() {
  const state = useCommandCenterStatus();
  const [activeModule, setActiveModule] = useState('timeline');
  const cards = buildStatusCards(state.data).filter(isAboveFoldStatusCard);
  const pendingCount = pendingApprovalCount(state.data);

  return (
    <div className="pi-command-center animate-fade-in">
      <Header pendingCount={pendingCount} state={state} />
      {state.error && <div className="pi-command-error" role="alert">{state.error}</div>}
      {state.loading && !state.data && <LoadingState />}
      <section className="pi-command-above-fold" aria-label="PI 控制台首屏重点">
        <div className="pi-command-status-column">
          <section className="pi-command-grid" aria-label="PI 控制台状态卡片">
            {cards.map(card => <StatusCard key={card.id} card={card} loading={state.loading && !state.data} />)}
          </section>
          <QuickActions activeModule={activeModule} onSelect={setActiveModule} />
        </div>
        <section className="pi-command-priority-panel" aria-label="待处理事项">
          <PendingApprovalCallout count={pendingCount} />
          <PiActionAuditPanel onChanged={state.reload} showAuditTimeline={false} variant="command-center" />
        </section>
      </section>
      <DetailModules activeModule={activeModule} onSelect={setActiveModule} reload={state.reload} />
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

function Header({ pendingCount, state }) {
  const overview = state.data?.overview || {};
  const heartbeat = heartbeatStatus(state.data?.heartbeat);
  const mode = modeText(state.data?.mode);
  return (
    <section className="pi-command-hero">
      <div>
        <span className="pi-command-kicker">PI 托管控制台</span>
        <h1>自动执行与审批中心</h1>
        <p>
          查看 {COMMAND_CENTER_TERMS.heartbeat}、处理高风险动作审批，并管理
          {COMMAND_CENTER_TERMS.delegation} 与 {COMMAND_CENTER_TERMS.policy}。
        </p>
        <div className="pi-command-hero-summary" aria-label="当前需要处理的事项">
          <span className={pendingCount > 0 ? 'urgent' : ''}>待审批 {numberText(overview.pending_approvals)} 项</span>
          <span>当前模式：{mode}</span>
          <span>最近自动检查：{heartbeat.detail}</span>
          <span>{promptDebugText(state.data?.prompt_debug)}</span>
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

function QuickActions({ activeModule, onSelect }) {
  return (
    <section className="pi-command-quick-actions" aria-label="主要操作入口">
      <div>
        <span className="pi-command-label">主要操作入口</span>
        <strong>先处理审批，再查看证据或调整授权。</strong>
      </div>
      <div className="pi-command-quick-action-row">
        {DETAIL_MODULES.map(([id, label, description]) => (
          <button
            className={activeModule === id ? 'active' : ''}
            key={id}
            onClick={() => onSelect(id)}
            type="button"
          >
            <span>{label}</span>
            <small>{description}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function PendingApprovalCallout({ count }) {
  const callout = approvalCalloutState(count);
  return (
    <div className={`pi-command-attention-callout ${callout.tone}`}>
      <span>{callout.status}</span>
      <strong>{callout.title}</strong>
      <p>{callout.detail}</p>
    </div>
  );
}

function DetailModules({ activeModule, onSelect, reload }) {
  const current = DETAIL_MODULES.find(([id]) => id === activeModule) || DETAIL_MODULES[0];
  return (
    <section className="pi-command-detail-shell" aria-label="PI 控制台二级模块">
      <div className="pi-command-detail-header">
        <div>
          <span className="pi-command-label">二级模块</span>
          <h2>{current[1]}</h2>
          <p>{current[2]}。这些信息默认收起，不再抢占首屏处理焦点。</p>
        </div>
        <div className="pi-command-tabs" role="tablist" aria-label="切换控制台模块">
          {DETAIL_MODULES.map(([id, label]) => (
            <button
              aria-selected={activeModule === id}
              className={activeModule === id ? 'active' : ''}
              key={id}
              onClick={() => onSelect(id)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="pi-command-tab-panel" role="tabpanel" aria-label={current[1]}>
        {renderActiveModule(activeModule, reload)}
      </div>
    </section>
  );
}

function renderActiveModule(activeModule, reload) {
  if (activeModule === 'reports') return <PiReportsPanel />;
  if (activeModule === 'delegations') return <PiDelegationsPanel onChanged={reload} />;
  if (activeModule === 'policy') return <PiPolicyEditorPanel onChanged={reload} />;
  return <PiHeartbeatTimelinePanel />;
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

function isAboveFoldStatusCard(card) {
  return ['mode', 'heartbeat', 'delegation'].includes(card.id);
}

function supervisorDetail(supervisor = {}) {
  return `${COMMAND_CENTER_TERMS.supervisor}：${numberText(supervisor.rate_limit_waits)} 次限流等待 · ${numberText(supervisor.needs_user_escalations)} 次需人工处理`;
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
  return modeLabel(mode);
}

function modeDetail(mode) {
  const details = {
    attended: 'PI 会给出建议，关键动作仍由人工确认',
    delegated: '已授权在委托窗口内自动推进',
    manual: '不会自动执行，需要人工触发',
  };
  return details[mode] || '等待 PI 策略初始化';
}

function promptDebugText(debug) {
  const summary = debug?.runtime_prompt_summary;
  if (!summary) return 'Prompt 摘要：未配置 Runner Agent';
  return summary.custom_instructions_configured
    ? `Prompt 摘要：${summary.custom_instructions_chars} chars custom instructions 已生效`
    : 'Prompt 摘要：未配置 custom instructions';
}

function statusText(status) {
  return statusLabel(status);
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function numberText(value) {
  return String(Number(value || 0));
}
