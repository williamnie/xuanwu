import { useCallback, useEffect, useState } from 'react';
import { Activity, Bot, CheckCircle2, Command, Database, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import PiActionAuditPanel from './PiActionAuditPanel';
import PiAutomationStatusPanel from './PiAutomationStatusPanel';
import PiDelegationsPanel from './PiDelegationsPanel';
import PiHeartbeatTimelinePanel from './PiHeartbeatTimelinePanel';
import PiGuardianPreferencesPanel from './PiGuardianPreferencesPanel';
import PiPolicyEditorPanel from './PiPolicyEditorPanel';
import PiReportsPanel from './PiReportsPanel';
import { COMMAND_CENTER_TERMS, modeLabel, statusLabel } from './piCommandCenterTerms';
import { approvalCalloutState, pendingApprovalCount } from './piCommandCenterState';
import './PiCommandCenter.css';
import './PiCommandCenter.layout.css';

const FRAMEWORK_SECTIONS = [];
const DETAIL_MODULES = [
  ['automation', '巡检启用状态', '区分自动执行、恢复、项目巡检与 heartbeat'],
  ['timeline', '自动检查时间线', '追踪最近运行证据'],
  ['reports', '恢复报告', '查看自动恢复汇总'],
  ['preferences', '通知偏好', '查看当前 preference 并提供最小创建/禁用入口'],
  ['delegations', '委托窗口', '创建或暂停授权窗口'],
  ['policy', '执行策略', '调整项目默认规则'],
];

export default function PiCommandCenter() {
  const state = useCommandCenterStatus();
  const [activeModule, setActiveModule] = useState('automation');
  const cards = buildStatusCards(state.data).filter(isAboveFoldStatusCard);
  const pendingCount = pendingApprovalCount(state.data);

  return (
    <div className="pi-command-center animate-fade-in">
      <Header pendingCount={pendingCount} state={state} />
      {state.error && <div className="pi-command-error" role="alert">{state.error}</div>}
      {state.loading && !state.data && <LoadingState />}
      <section className="pi-command-above-fold" aria-label="PI 诊断首屏重点">
        <div className="pi-command-status-column">
          <section className="pi-command-grid" aria-label="PI 诊断状态卡片">
            {cards.map(card => <StatusCard key={card.id} card={card} loading={state.loading && !state.data} />)}
          </section>
          <QuickActions activeModule={activeModule} onSelect={setActiveModule} />
        </div>
        <section className="pi-command-priority-panel" aria-label="审计与确认记录">
          <PendingApprovalCallout count={pendingCount} />
          <PiActionAuditPanel onChanged={state.reload} showAuditTimeline={false} variant="command-center" />
        </section>
      </section>
      <DetailModules activeModule={activeModule} automation={state.data?.automation} onSelect={setActiveModule} reload={state.reload} />
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
      setState(prev => ({ ...prev, error: err.message || '读取 PI 诊断状态失败', loading: false }));
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
        <span className="pi-command-kicker">PI 诊断 / 审计</span>
        <h1>诊断与高级设置</h1>
        <p>
          日常审批请优先在 Feishu IM 或单个 issue detail 完成；这里保留
          debug、audit、system status 与高级策略设置，用于排障和复核。
        </p>
        <div className="pi-command-hero-summary" aria-label="当前诊断摘要">
          <span className={pendingCount > 0 ? 'urgent' : ''}>审计待确认 {numberText(overview.pending_approvals)} 项</span>
          <span>当前模式：{mode}</span>
          <span>最近自动检查：{heartbeat.detail}</span>
          <span>{memorySummaryText(state.data?.memory)}</span>
          <span>{promptDebugText(state.data?.prompt_debug)}</span>
          <span>{supervisorAgentText(state.data?.supervisor?.agent)}</span>
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
    <section className="pi-command-quick-actions" aria-label="PI 诊断入口">
      <div>
        <span className="pi-command-label">诊断入口</span>
        <strong>保留排障、审计和高级策略入口；日常确认从 IM / issue detail 进入。</strong>
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

function DetailModules({ activeModule, automation, onSelect, reload }) {
  const current = DETAIL_MODULES.find(([id]) => id === activeModule) || DETAIL_MODULES[0];
  return (
    <section className="pi-command-detail-shell" aria-label="PI 诊断二级模块">
      <div className="pi-command-detail-header">
        <div>
          <span className="pi-command-label">二级模块</span>
          <h2>{current[1]}</h2>
          <p>{current[2]}。这些信息用于排障和高级设置，不作为日常审批入口。</p>
        </div>
        <div className="pi-command-tabs" role="tablist" aria-label="切换诊断模块">
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
        {renderActiveModule(activeModule, reload, automation)}
      </div>
    </section>
  );
}

function renderActiveModule(activeModule, reload, automation) {
  if (activeModule === 'automation') return <PiAutomationStatusPanel automation={automation} onChanged={reload} />;
  if (activeModule === 'reports') return <PiReportsPanel />;
  if (activeModule === 'preferences') return <PiGuardianPreferencesPanel />;
  if (activeModule === 'delegations') return <PiDelegationsPanel onChanged={reload} />;
  if (activeModule === 'policy') return <PiPolicyEditorPanel onChanged={reload} />;
  return <PiHeartbeatTimelinePanel />;
}

function LoadingState() {
  return (
    <div className="pi-command-loading" aria-live="polite">
      <Loader2 size={16} className="spin-animation" />
      正在读取 PI 诊断状态…
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
    <section className="pi-command-module" aria-label="PI 诊断框架占位">
      <h2><Command size={18} /> 诊断后续模块</h2>
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
    { detail: `${numberText(overview.autonomous_projects)} 个项目开启 PI manager auto-manage`, icon: ShieldCheck, id: 'delegation', label: '项目巡检/委托', value: `${numberText(overview.active_delegations)} 个委托生效中` },
    { detail: '诊断视图：高风险动作的日常确认入口在 Feishu IM / issue detail', icon: CheckCircle2, id: 'approvals', label: '待确认审计', value: `${numberText(overview.pending_approvals)} 项` },
    { detail: supervisorDetail(data?.supervisor), icon: Bot, id: 'supervisor', label: '自动恢复', value: `${numberText(data?.supervisor?.recovery_actions)} 次` },
    { detail: memoryDetail(data?.memory), icon: Database, id: 'memory', label: 'PI 记忆', value: `待审核候选 ${numberText(data?.memory?.candidate_count)} 条` },
  ];
}

function isAboveFoldStatusCard(card) {
  return ['mode', 'heartbeat', 'delegation', 'memory'].includes(card.id);
}

function supervisorDetail(supervisor = {}) {
  return `${COMMAND_CENTER_TERMS.supervisor}：${numberText(supervisor.rate_limit_waits)} 次限流等待 · ${numberText(supervisor.needs_user_escalations)} 次需人工处理 · ${supervisorAgentText(supervisor.agent)}`;
}

function supervisorAgentText(agent = {}) {
  if (agent.status === 'fallback') return `Supervisor Agent：已 fallback 到全局 PI agent ${agent.agent_name || agent.agent_id || ''}`.trim();
  if (agent.status === 'needs_configuration') return 'Supervisor Agent：请绑定或启用一个 PI agent';
  if (agent.status === 'bound') return `Supervisor Agent：已绑定 ${agent.agent_name || agent.agent_id || ''}`.trim();
  return 'Supervisor Agent：等待配置状态';
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

function memorySummaryText(memory = {}) {
  return `PI 记忆：active ${numberText(memory.active_count)} · candidate ${numberText(memory.candidate_count)}`;
}

function memoryDetail(memory = {}) {
  const source = memory.recent_candidate_sources?.[0];
  if (!source) return `active ${numberText(memory.active_count)} 条 · 待审核候选 ${numberText(memory.candidate_count)} 条 · 最近候选来源：暂无`;
  return `active ${numberText(memory.active_count)} 条 · 待审核候选 ${numberText(memory.candidate_count)} 条 · 最近候选来源：${source.source_type || 'unknown'}:${source.source_id || source.id}`;
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
