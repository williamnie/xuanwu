import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, BellRing, Check, RefreshCw, ShieldCheck, ShieldX, TimerReset, X } from 'lucide-react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { eventsApi } from '../../api/events.js';
import { message as toast } from '../../store/toastStore.js';
import { ATTENTION_PRIORITIES, approvalIDFromAttention, attentionActionPayload, attentionView, groupAttentionByPriority } from './attentionModel.js';
import './AttentionSection.css';

const REFRESH_INTERVAL_MS = 30_000;

export default function AttentionSection({ navigateTo }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState('');
  const [approval, setApproval] = useState({ detail: null, error: '', loading: false });
  const [typeFilter, setTypeFilter] = useState('');

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await commandCenterApi.getSummary({ limit: 25, sections: ['attention'] });
      const section = response?.sections?.attention;
      if (!section || section.status !== 'ok') throw new Error(section?.error?.message || 'Attention 分区暂不可用');
      setSummary({ compatibility: response.compatibility || null, section });
      setError('');
    } catch (loadError) {
      setError(loadError.message || '加载 Attention 失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const interval = window.setInterval(() => load({ silent: true }), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);
  useEffect(() => eventsApi.subscribeToEvents(event => {
    if (event?.type === 'approval.resolved' || String(event?.type || '').startsWith('issue.')) load({ silent: true });
  }), [load]);

  const items = useMemo(() => summary?.section?.items || [], [summary]);
  const filteredItems = useMemo(() => typeFilter ? items.filter(item => item.type === typeFilter) : items, [items, typeFilter]);
  const groups = useMemo(() => groupAttentionByPriority(filteredItems), [filteredItems]);
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
    const id = approvalIDFromAttention(item);
    if (!id) return;
    setApproval({ detail: null, error: '', loading: true });
    try {
      setApproval({ detail: await commandCenterApi.getApproval(id), error: '', loading: false });
    } catch (reviewError) {
      setApproval({ detail: null, error: reviewError.message || '读取 Approval 失败', loading: false });
    }
  };
  const resolveApproval = async decision => {
    if (!approval.detail || submitting) return;
    setSubmitting(`approval:${decision}`);
    try {
      await commandCenterApi.resolveApproval(approval.detail.approval_id, { decision, scope: 'turn' });
      toast.success(decision === 'approve' ? 'Approval 已批准；provider 将恢复当前 turn' : 'Approval 已拒绝并记录审计');
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
          <h3>优先处理需要人工介入的事项</h3>
          <p>等待审批、阻塞、失败、等待输入和待验收事项按确定性优先级排列。</p>
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

      {error ? <State error={error} onRetry={() => load()} /> : loading && !summary ? <State loading /> : filteredItems.length === 0 ? <State filtered={Boolean(typeFilter)} /> : (
        <div className="attention-priority-groups">
          {ATTENTION_PRIORITIES.map(priority => groups[priority].length > 0 ? (
            <div className="attention-priority-group" data-priority={priority} key={priority}>
              <div className="attention-priority-heading"><strong>{priority.toUpperCase()}</strong><span>{groups[priority].length} 项</span></div>
              {groups[priority].map(item => <AttentionCard item={item} key={item.id} navigateTo={navigateTo} onReviewApproval={reviewApproval} onSubmit={submit} submitting={submitting} />)}
            </div>
          ) : null)}
        </div>
      )}
      {approval.loading || approval.error || approval.detail ? <ApprovalDetail approval={approval} onClose={() => setApproval({ detail: null, error: '', loading: false })} onResolve={resolveApproval} submitting={submitting} /> : null}
    </section>
  );
}

function AttentionCard({ item, navigateTo, onReviewApproval, onSubmit, submitting }) {
  const view = attentionView(item);
  const pending = (action) => submitting === `${item.id}:${action}`;
  return <article className={`attention-card ${view.tone}`}>
    <div className="attention-card-topline"><span>{view.typeLabel}</span><span>{view.statusLabel}</span></div>
    <strong>{item.summary}</strong>
    <p>{view.actionLabel}</p>
    <div className="attention-card-actions">
      {view.canAcknowledge ? <button disabled={Boolean(submitting)} onClick={() => onSubmit(item, 'acknowledge')} type="button"><Check size={13} /> {pending('acknowledge') ? '提交中…' : '确认'}</button> : null}
      {view.canSnooze ? <button disabled={Boolean(submitting)} onClick={() => onSubmit(item, 'snooze')} type="button"><TimerReset size={13} /> {pending('snooze') ? '提交中…' : '暂停 1 小时'}</button> : null}
      {item.type === 'approval_required' && approvalIDFromAttention(item) ? (
        <button className="open" onClick={() => onReviewApproval(item)} type="button">审阅 Approval <ShieldCheck size={13} /></button>
      ) : item.links?.view === '#/attention-inbox' ? (
        <button className="open" onClick={() => navigateTo?.('attention-inbox')} type="button">打开来源 <ArrowUpRight size={13} /></button>
      ) : (
        <a className="open" href={item.links?.self} rel="noreferrer noopener" target="_blank">打开来源 <ArrowUpRight size={13} /></a>
      )}
    </div>
  </article>;
}

function ApprovalDetail({ approval, onClose, onResolve, submitting }) {
  return <section className="approval-detail" aria-live="polite">
    <header><div><span><ShieldCheck size={14} /> Approval detail</span><h3>{approval.detail?.request_summary || approval.detail?.summary || '审批请求'}</h3></div><button aria-label="关闭 Approval 详情" onClick={onClose} type="button"><X size={16} /></button></header>
    {approval.loading ? <div className="approval-detail-state"><RefreshCw className="is-spinning" size={19} />正在读取审批事实…</div> : approval.error ? <div className="approval-detail-state error"><AlertTriangle size={19} />{approval.error}</div> : <>
      <div className="approval-detail-grid">
        <ApprovalFact label="Request" value={approval.detail.approval_id} /><ApprovalFact label="Risk" value={approval.detail.risk} />
        <ApprovalFact label="Provider" value={approval.detail.provider || 'codex'} /><ApprovalFact label="Type" value={approval.detail.request_type || 'approval'} />
        <ApprovalFact label="Project" value={approval.detail.project_id || '—'} /><ApprovalFact label="Run" value={approval.detail.run_id || approval.detail.session_id || '—'} />
      </div>
      {approval.detail.resolver_error ? <div className="approval-resolver-error"><AlertTriangle size={14} />{approval.detail.resolver_error}</div> : null}
      <footer><span>确定性 gate 仅授权当前 turn；操作会写入 `pi_approval_requests` resolver audit。</span><button disabled={Boolean(submitting)} onClick={() => onResolve('deny')} type="button"><ShieldX size={14} />拒绝</button><button className="approve" disabled={Boolean(submitting)} onClick={() => onResolve('approve')} type="button"><ShieldCheck size={14} />批准一次</button></footer>
    </>}
  </section>;
}

function ApprovalFact({ label, value }) { return <div><small>{label}</small><strong>{value || '—'}</strong></div>; }

function State({ error = '', filtered = false, loading = false, onRetry }) {
  if (error) return <div className="attention-state error" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={onRetry} type="button">重试</button></div>;
  if (loading) return <div className="attention-state"><RefreshCw className="is-spinning" size={20} /><strong>正在读取 Attention…</strong></div>;
  return <div className="attention-state"><BellRing size={22} /><strong>{filtered ? '当前筛选下没有事项' : '当前没有需要关注的事项'}</strong><span>{filtered ? '选择其他类型查看 Attention queue。' : '新的审批、阻塞、失败、输入或验收事项会实时出现在这里。'}</span></div>;
}
