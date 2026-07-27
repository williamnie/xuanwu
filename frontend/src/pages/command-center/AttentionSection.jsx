import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, BellRing, Bot, Check, CheckCircle2, Clock3, History, MapPin, RefreshCw, ShieldCheck, ShieldX, TimerReset, Wrench, X } from 'lucide-react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { eventsApi } from '../../api/events.js';
import { message as toast } from '../../store/toastStore.js';
import { ATTENTION_PRIORITIES, attentionActionPayload, attentionView, groupAttentionByPriority } from './attentionModel.js';
import './AttentionSection.css';

const REFRESH_INTERVAL_MS = 30_000;

export default function AttentionSection() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState('');
  const [approval, setApproval] = useState({ detail: null, error: '', loading: false });
  const [typeFilter, setTypeFilter] = useState('');
  const requestRef = useRef(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (requestRef.current) return requestRef.current.promise;
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
    return () => requestRef.current?.controller.abort();
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

  const items = useMemo(() => summary?.section?.items || [], [summary]);
  const filteredItems = useMemo(() => typeFilter ? items.filter(item => item.type === typeFilter) : items, [items, typeFilter]);
  const pushedApprovals = useMemo(() => filteredItems.filter(isPushedApproval), [filteredItems]);
  const primaryItems = useMemo(() => filteredItems.filter(item => !isPushedApproval(item)), [filteredItems]);
  const groups = useMemo(() => groupAttentionByPriority(primaryItems), [primaryItems]);
  const submit = async (item, action) => {
    if (submitting) return;
    setSubmitting(`${item.id}:${action}`);
    try {
      await commandCenterApi.controlAttention(item.id, action, attentionActionPayload(item, action));
      toast.success(action === 'acknowledge' ? 'Attention 已确认并记录审计' : 'Attention 已暂停 1 小时并记录审计');
      await load({ silent: true });
    } catch (actionError) {
      toast.error(actionError.message || 'Attention 操作失败');
    } finally {
      setSubmitting('');
    }
  };

  const reviewApproval = async item => {
    setApproval({ detail: null, error: '', loading: true });
    try {
      setApproval({ detail: await commandCenterApi.getAttention(item.id), error: '', loading: false });
    } catch (reviewError) {
      setApproval({ detail: null, error: reviewError.message || '读取 Approval 失败', loading: false });
    }
  };
  const resolveApproval = async (decision, target) => {
    if (!approval.detail || submitting) return;
    setSubmitting(`${target.ref}:${decision}`);
    try {
      await commandCenterApi.controlAttention(approval.detail.attention.id, decision, {
        actor: 'frontend:user',
        decision_ref: target.ref,
        reason: `Command Center user ${decision}d ${target.kind}`,
        scope: 'turn',
      });
      toast.success(decision === 'approve_always'
        ? '当前项目持续授权已记录，本次动作已进入执行链'
        : decision === 'approve' ? 'Decision 已批准并进入唯一 Action Gate 执行链' : 'Decision 已拒绝并记录审计');
      setApproval({ detail: null, error: '', loading: false });
      await load({ silent: true });
    } catch (resolveError) {
      toast.error(resolveError.message || 'Approval 操作失败');
    } finally { setSubmitting(''); }
  };

  return (
    <section className="attention-section" aria-busy={loading}>
      <header className="attention-section-header">
        <div>
          <div className="attention-section-kicker"><BellRing size={15} /> Attention</div>
          <h3>这里只放未送达或必须兜底处理的事项</h3>
          <p>高危审批优先推送飞书；页面是失败兜底与审计入口，已推送事项默认折叠。</p>
        </div>
        <div className="attention-section-header-actions">
          <select aria-label="Attention 类型筛选" className="attention-type-filter" onChange={event => setTypeFilter(event.target.value)} value={typeFilter}>
            <option value="">全部类型</option><option value="approval_required">等待审批</option><option value="failure">失败</option>
            <option value="blocker">阻塞</option><option value="input_required">等待输入</option><option value="verification_required">待验收</option><option value="connection_issue">连接异常</option>
          </select>
          {summary?.section?.freshness?.is_stale ? <span className="attention-freshness"><AlertTriangle size={13} /> 数据可能过期</span> : null}
          <span className="attention-count">{summary?.section?.counts?.total ?? items.length}</span>
          <button aria-label="刷新 Attention" disabled={loading} onClick={() => load()} type="button"><RefreshCw className={loading ? 'is-spinning' : ''} size={15} /></button>
        </div>
      </header>

      {!error && summary ? <PiOperationsSummary operations={summary.section.operations} recentHistory={summary.section.recent_history} /> : null}

      {error ? <State error={error} onRetry={() => load()} /> : loading && !summary ? <State loading /> : filteredItems.length === 0 ? <State filtered={Boolean(typeFilter)} /> : (
        <><div className="attention-priority-groups">
          {ATTENTION_PRIORITIES.map(priority => groups[priority].length > 0 ? (
            <div className="attention-priority-group" data-priority={priority} key={priority}>
              <div className="attention-priority-heading"><strong>{priority.toUpperCase()}</strong><span>{groups[priority].length} 项</span></div>
              {groups[priority].map(item => <AttentionCard item={item} key={item.id} onReviewApproval={reviewApproval} onSubmit={submit} submitting={submitting} />)}
            </div>
          ) : null)}
        </div><PushedApprovalFallback items={pushedApprovals} onReviewApproval={reviewApproval} onSubmit={submit} submitting={submitting} /></>
      )}
      {approval.loading || approval.error || approval.detail ? <ApprovalDetail approval={approval} onClose={() => setApproval({ detail: null, error: '', loading: false })} onResolve={resolveApproval} submitting={submitting} /> : null}
    </section>
  );
}

function isPushedApproval(item) {
  const delivery = item?.details?.notification?.delivery;
  return item?.type === 'approval_required' && delivery === 'sent';
}

function PushedApprovalFallback({ items, onReviewApproval, onSubmit, submitting }) {
  if (!items.length) return null;
  return <details className="attention-pushed-approvals">
    <summary><ShieldCheck size={13} /> 已推送飞书，页面仅保留 {items.length} 条兜底记录</summary>
    <div>{items.map(item => <AttentionCard item={item} key={item.id} onReviewApproval={onReviewApproval} onSubmit={onSubmit} submitting={submitting} />)}</div>
  </details>;
}

function AttentionCard({ item, onReviewApproval, onSubmit, submitting }) {
  const view = attentionView(item);
  const details = item.details || {};
  const pending = (action) => submitting === `${item.id}:${action}`;
  return <article className={`attention-card ${view.tone}`}>
    <div className="attention-card-topline"><span>{view.typeLabel}</span><span>{details.state_label || view.statusLabel}</span></div>
    <strong>{details.title || item.summary}</strong>
    <p>{details.description || view.actionLabel}</p>
    {details.diagnostic && details.diagnostic !== details.title ? <code className="attention-card-diagnostic">{details.diagnostic}</code> : null}
    <div className="attention-card-facts">
      <span><MapPin size={12} />{details.location || 'Runner 系统'}</span>
      <span><Clock3 size={12} />首次 {formatTime(details.first_seen_at || item.created_at)}</span>
      <span><Wrench size={12} />来源 {details.component || details.source || 'Attention'}</span>
    </div>
    <div className="attention-card-next"><strong>需要你做什么</strong><span>{details.user_action || view.actionLabel}</span></div>
    {details.pi_action ? <div className="attention-card-pi"><Bot size={14} /><span><strong>PI 已经做的：</strong>{details.pi_action}</span></div> : null}
    <div className="attention-card-actions">
      {view.canAcknowledge ? <button disabled={Boolean(submitting)} onClick={() => onSubmit(item, 'acknowledge')} type="button"><Check size={13} /> {pending('acknowledge') ? '提交中…' : '我知道了，不再显示'}</button> : null}
      {view.canSnooze ? <button disabled={Boolean(submitting)} onClick={() => onSubmit(item, 'snooze')} type="button"><TimerReset size={13} /> {pending('snooze') ? '提交中…' : '稍后提醒'}</button> : null}
      {item.type === 'approval_required' ? (
        <button className="open" onClick={() => onReviewApproval(item)} type="button">审阅 Decision <ShieldCheck size={13} /></button>
      ) : item.links?.view === '#/attention-inbox' ? (
        <a className="open" href={item.links?.self} rel="noreferrer noopener" target="_blank">查看来源事实 <ArrowUpRight size={13} /></a>
      ) : (
        <a className="open" href={item.links?.self} rel="noreferrer noopener" target="_blank">打开具体来源 <ArrowUpRight size={13} /></a>
      )}
    </div>
  </article>;
}

function PiOperationsSummary({ operations, recentHistory }) {
  const summary = operations?.summary || {};
  const active = operations?.active || [];
  const history = recentHistory || [];
  return <section className="pi-operations-summary">
    <header>
      <div><Bot size={17} /><span><strong>PI 自动运维</strong><small>过去 24 小时</small></span></div>
      <span className="pi-operations-state"><CheckCircle2 size={14} />{summary.active_user_action_required > 0 ? `${summary.active_user_action_required} 项待你处理` : '无需人工介入'}</span>
    </header>
    <div className="pi-operations-metrics">
      <Metric label="发现告警" value={summary.alerts_detected} />
      <Metric label="自动恢复" value={summary.alerts_recovered} success />
      <Metric label="恢复会话" value={summary.session_recoveries} success />
      <Metric label="恢复 Issue" value={summary.issue_retries_recovered} success />
    </div>
    {active.length > 0 ? <div className="pi-operations-active"><strong><Bot size={13} /> PI 正在处理 {active.length} 项</strong>{active.map(item => <span key={item.id}>{item.details?.title || item.summary} · {item.details?.location}</span>)}</div> : null}
    {history.length > 0 ? <details className="pi-operations-history"><summary><History size={13} /> 最近已恢复 {history.length} 项</summary>{history.map(item => <span key={item.alert_id}>{item.title} · {item.location} · {formatTime(item.last_seen_at)}</span>)}</details> : null}
    <footer>运行过程不再逐条弹警告；PI 每天按通知偏好发送一份运维日报。</footer>
  </section>;
}

function Metric({ label, success = false, value = 0 }) {
  return <div className={success ? 'success' : ''}><strong>{value ?? 0}</strong><span>{label}</span></div>;
}

function formatTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '时间未知';
}

function ApprovalDetail({ approval, onClose, onResolve, submitting }) {
  const attention = approval.detail?.attention;
  const decisions = approval.detail?.decisions || [];
  return <section className="approval-detail" aria-live="polite">
    <header><div><span><ShieldCheck size={14} /> Decision detail</span><h3>{attention?.summary || '审批请求'}</h3></div><button aria-label="关闭 Approval 详情" onClick={onClose} type="button"><X size={16} /></button></header>
    {approval.loading ? <div className="approval-detail-state"><RefreshCw className="is-spinning" size={19} />正在读取审批事实…</div> : approval.error ? <div className="approval-detail-state error"><AlertTriangle size={19} />{approval.error}</div> : <>
      {decisions.map(target => <div className="approval-decision-target" key={target.ref}>
        <div className="approval-detail-grid">
          <ApprovalFact label="Decision" value={target.ref} /><ApprovalFact label="Risk" value={target.risk} />
          <ApprovalFact label="Kind" value={target.kind} /><ApprovalFact label="Status" value={target.status} />
        </div>
        <p>{target.summary}</p>
        {target.actions?.length ? <div className="proposal-actions-list">{target.actions.map(action => <div className="proposal-action-row" key={action.id}><strong>{action.type}</strong><small>{action.risk} · {action.status}</small><span>{action.summary}</span></div>)}</div> : null}
        {target.status === 'pending' || target.status === 'proposed' || target.status === 'delivered' || target.status === 'resolve_failed' ? <footer>
          <span>旧 API 只翻译到此确定性 command；每个外部写仍经同一 Action Gate。</span>
          <button disabled={Boolean(submitting)} onClick={() => onResolve('reject', target)} type="button"><ShieldX size={14} />拒绝</button>
          {target.kind === 'pi_action' && target.action_type === 'mcp.tool.call' && target.project_id ? <button disabled={Boolean(submitting)} onClick={() => onResolve('approve_always', target)} type="button"><ShieldCheck size={14} />当前项目始终允许</button> : null}
          <button className="approve" disabled={Boolean(submitting)} onClick={() => onResolve('approve', target)} type="button"><ShieldCheck size={14} />批准一次</button>
        </footer> : null}
      </div>)}
    </>}
  </section>;
}

function ApprovalFact({ label, value }) { return <div><small>{label}</small><strong>{value || '—'}</strong></div>; }

function State({ error = '', filtered = false, loading = false, onRetry }) {
  if (error) return <div className="attention-state error" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={onRetry} type="button">重试</button></div>;
  if (loading) return <div className="attention-state"><RefreshCw className="is-spinning" size={20} /><strong>正在读取 Attention…</strong></div>;
  return <div className="attention-state"><CheckCircle2 size={22} /><strong>{filtered ? '当前筛选下没有事项' : '当前没有需要你介入的事项'}</strong><span>{filtered ? '选择其他类型查看。' : 'PI 正在后台处理运行告警；需要你决定时才会出现在这里。'}</span></div>;
}
