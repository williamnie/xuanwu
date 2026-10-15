import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Bot, Check, CheckCircle2, Clock3, History, MapPin, RefreshCw, ShieldCheck, ShieldX, TimerReset, Wrench, X } from 'lucide-react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { eventsApi } from '../../api/events.js';
import { useI18n } from '../../i18n/context.js';
import { attentionView } from './attentionModel.js';
import './AttentionSection.css';

const REFRESH_INTERVAL_MS = 30_000;

export default function AttentionSection() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const { t } = useI18n();
  const requestRef = useRef(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (requestRef.current) {
      try { await requestRef.current.promise; } catch { /* owning request handles its result */ }
      return;
    }
    if (!silent) setLoading(true);
    const controller = new AbortController();
    const promise = commandCenterApi.getSummary(
      { limit: 25, sections: ['attention'] },
      { signal: controller.signal },
    );
    requestRef.current = { controller, promise };
    try {
      const response = await promise;
      const section = response?.sections?.attention;
      if (!section || section.status !== 'ok') throw new Error(section?.error?.message || 'Attention 分区暂不可用');
      setSummary({ compatibility: response.compatibility || null, section });
      setError('');
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') setError(loadError.message || '加载 Attention 失败');
    } finally {
      if (requestRef.current?.promise === promise) requestRef.current = null;
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      const activeRequest = requestRef.current;
      requestRef.current = null;
      activeRequest?.controller.abort();
    };
  }, [load]);
  useEffect(() => {
    const interval = window.setInterval(() => load({ silent: true }), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);
  useEffect(() => {
    let timer = 0;
    const unsubscribe = eventsApi.subscribeToEvents(event => {
      if (timer || !(event?.type === 'approval.resolved' || String(event?.type || '').startsWith('issue.'))) return;
      timer = window.setTimeout(() => {
        timer = 0;
        load({ silent: true });
      }, 250);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  return <section className="attention-section e2b-terminal-window" aria-busy={loading}>
    <header className="attention-section-header">
      <div><div className="attention-section-kicker"><Bot size={15} /> OPERATIONS</div><h3>{t('inbox.operations')}</h3><p>{t('inbox.operationsDetail')}</p></div>
      <div className="attention-section-header-actions"><button aria-label={t('inbox.refreshOperations')} disabled={loading} onClick={() => load()} type="button"><RefreshCw className={loading ? 'is-spinning' : ''} size={15} /></button></div>
    </header>
    {error ? <State error={error} onRetry={() => load()} /> : loading && !summary ? <State loading /> : null}
    {summary ? <PiOperationsSummary operations={summary.section.operations} recentHistory={summary.section.recent_history} /> : null}
  </section>;
}

export function AttentionCard({ item, onReviewApproval, onSubmit, submitting }) {
  const { t } = useI18n();
  const view = attentionView(item);
  const details = item.details || {};
  const pending = (action) => submitting === `${item.id}:${action}`;
  return <article className="ds-request-card" data-tone={item.type === 'failure' ? 'error' : 'warning'}>
    <span className="dot" />
    <div className="attention-request-content">
      <div className="kind">{view.typeLabel} · {details.state_label || view.statusLabel}</div>
      <div className="title">{details.title || item.summary}</div>
      <div className="detail">{details.description || view.actionLabel}</div>
      {details.notification?.delivery === 'sent' ? <div className="detail">{t('inbox.sent')}</div> : null}
      <details className="attention-request-facts"><summary>{t('inbox.details')}</summary>
        {details.diagnostic && details.diagnostic !== details.title ? <code className="attention-card-diagnostic">{details.diagnostic}</code> : null}
        <div className="attention-card-facts"><span><MapPin size={13} />{details.location || 'Runner'}</span><span><Clock3 size={13} />{formatTime(details.first_seen_at || item.created_at)}</span><span><Wrench size={13} />{details.component || details.source || 'Attention'}</span></div>
        <div className="detail">{t('inbox.nextAction')}：{details.user_action || view.actionLabel}</div>
        {details.pi_action ? <div className="detail">{t('inbox.assistantAction')}：{details.pi_action}</div> : null}
      </details>
    </div>
    <div className="actions">
      {view.canAcknowledge ? <button className="btn btn-secondary" disabled={Boolean(submitting)} onClick={() => onSubmit(item, 'acknowledge')} type="button"><Check size={13} />{pending('acknowledge') ? t('inbox.submitting') : t('inbox.acknowledge')}</button> : null}
      {view.canSnooze ? <button className="btn btn-secondary" disabled={Boolean(submitting)} onClick={() => onSubmit(item, 'snooze')} type="button"><TimerReset size={13} />{pending('snooze') ? t('inbox.submitting') : t('inbox.snooze')}</button> : null}
      {item.type === 'approval_required' ? <button className="btn btn-secondary" onClick={() => onReviewApproval(item)} type="button">{t('inbox.reviewApproval')} <ShieldCheck size={13} /></button>
        : <a className="btn btn-secondary" href={item.links?.self} rel="noreferrer noopener" target="_blank">{t('inbox.sourceFacts')} <ArrowUpRight size={13} /></a>}
    </div>
  </article>;
}

function PiOperationsSummary({ operations, recentHistory }) {
  const { t } = useI18n();
  const summary = operations?.summary || {};
  const active = operations?.active || [];
  const history = recentHistory || [];
  return <section className="pi-operations-summary">
    <header>
      <div><Bot size={14} /><span><strong>玄武自动运维</strong><small>过去 24 小时</small></span></div>
      <span className="pi-operations-state"><CheckCircle2 size={14} />{t('inbox.operationsOnly')}</span>
    </header>
    <div className="pi-operations-metrics">
      <Metric label="发现告警" value={summary.alerts_detected} />
      <Metric label="自动恢复" value={summary.alerts_recovered} success />
      <Metric label="恢复会话" value={summary.session_recoveries} success />
      <Metric label="恢复任务" value={summary.issue_retries_recovered} success />
    </div>
    {active.length > 0 ? <div className="pi-operations-active"><strong><Bot size={13} /> 玄武正在处理 {active.length} 项</strong>{active.map(item => <span key={item.id}>{item.details?.title || item.summary} · {item.details?.location}</span>)}</div> : null}
    {history.length > 0 ? <details className="pi-operations-history"><summary><History size={13} /> 最近已恢复 {history.length} 项</summary>{history.map(item => <span key={item.alert_id}>{item.title} · {item.location} · {formatTime(item.last_seen_at)}</span>)}</details> : null}
    <footer>运行过程不再逐条弹警告；玄武每天按通知偏好发送一份运维日报。</footer>
  </section>;
}

function Metric({ label, success = false, value = 0 }) {
  return <div className={success ? 'success' : ''}><strong>{value ?? 0}</strong><span>{label}</span></div>;
}

function formatTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '时间未知';
}

export function ApprovalDetail({ approval, onClose, onResolve, submitting }) {
  const { t } = useI18n();
  const attention = approval.detail?.attention;
  const decisions = approval.detail?.decisions || [];
  return <section className="approval-detail" aria-live="polite" aria-label={t('inbox.reviewApproval')} role="dialog" aria-modal="true">
    <header><div><span><ShieldCheck size={14} /> Approval detail</span><h3>{attention?.summary || '审批请求'}</h3></div><button aria-label="关闭审批详情" onClick={onClose} type="button"><X size={16} /></button></header>
    {approval.loading ? <div className="approval-detail-state"><RefreshCw className="is-spinning" size={16} />正在读取审批事实…</div> : approval.error ? <div className="approval-detail-state error"><AlertTriangle size={16} />{approval.error}</div> : <>
      {decisions.map(target => {
        const gate = target.gate || {};
        const actionable = target.status === 'pending' || target.status === 'proposed' || target.status === 'delivered' || target.status === 'resolve_failed';
        const canApprove = gate.can_approve !== false;
        return <div className="approval-decision-target" key={target.ref}>
          <div className="approval-detail-grid">
            <ApprovalFact label="Decision" value={target.ref} /><ApprovalFact label="Risk" value={target.risk} />
            <ApprovalFact label="Kind" value={target.kind} /><ApprovalFact label="Status" value={target.status} />
            <ApprovalFact label="Gate layer" value={gateLayerLabel(gate.blocked_layer)} />
            <ApprovalFact label="Reason code" value={gate.reason_code} />
            <ApprovalFact label="Scope" value={formatGateScope(gate.scope)} />
            <ApprovalFact label="Authorization" value={authorizationSourceLabel(gate.authorization_source)} />
            <ApprovalFact label="Freshness" value={gateFreshnessLabel(gate.freshness)} />
            <ApprovalFact label="Expires" value={formatGateExpiry(gate.expires_at)} />
          </div>
          <p>{gate.reason || target.summary}</p>
          <p>{gate.user_action || '核对当前状态和审计记录后再决定。'}</p>
          {target.actions?.length ? <div className="proposal-actions-list">{target.actions.map(action => <div className="proposal-action-row" key={action.id}><strong>{action.type}</strong><small>{action.risk} · {action.status}</small><span>{action.summary}</span></div>)}</div> : null}
          {actionable ? <footer>
            <span>{gate.user_action || '编程工具执行权限、Action Gate、MCP 策略与完成门禁分别裁决，不会互相提升权限。'}</span>
            <button disabled={Boolean(submitting)} onClick={() => onResolve('reject', target)} type="button"><ShieldX size={14} />拒绝</button>
            {target.kind === 'pi_action' && target.action_type === 'mcp.tool.call' && target.project_id ? <button disabled={Boolean(submitting) || !canApprove} onClick={() => onResolve('approve_always', target)} type="button"><ShieldCheck size={14} />当前项目始终允许</button> : null}
            <button className="approve" disabled={Boolean(submitting) || !canApprove} onClick={() => onResolve('approve', target)} type="button"><ShieldCheck size={14} />批准一次</button>
          </footer> : null}
        </div>;
      })}
    </>}
  </section>;
}

function ApprovalFact({ label, value }) { return <div><small>{label}</small><strong>{value || '—'}</strong></div>; }

function gateLayerLabel(layer) {
  return ({
    action_gate: 'Action Gate · 业务动作',
    completion_gate: 'Completion Gate · 完成验收',
    mcp_policy: 'MCP Policy · 外部能力',
    provider_execution_policy: '编程工具 Policy · Agent 工具权限',
    source_policy: 'Source Policy · 来源动作',
  })[layer] || layer || '未声明';
}

function authorizationSourceLabel(source) {
  return ({
    current_runner_chat_turn: '当前对话明确授权',
    deterministic_policy: '确定性策略',
    human_approval: '人工审批',
    provider_callback: '编程工具回调',
    source_policy: '来源策略',
    supervisor_policy: '玄武助手策略',
  })[source] || source || '未声明';
}

function gateFreshnessLabel(freshness) {
  return ({ current: '当前有效', expired: '已过期', stale: '目标已变化', terminal: '已结束' })[freshness] || freshness || '未知';
}

function formatGateScope(scope) {
  const entries = Object.entries(scope || {});
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join(' · ')
    : 'Runner 全局';
}

function formatGateExpiry(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '无独立期限';
}

function State({ error = '', loading = false, onRetry }) {
  const { t } = useI18n();
  if (error) return <div className="attention-state error" role="alert"><AlertTriangle size={16} /><span>{error}</span><button onClick={onRetry} type="button">{t('inbox.retry')}</button></div>;
  if (loading) return <div className="attention-state"><RefreshCw className="is-spinning" size={16} /><strong>{t('inbox.loadingOperations')}</strong></div>;
  return null;
}
