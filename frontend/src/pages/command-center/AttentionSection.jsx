import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, BellRing, Check, RefreshCw, TimerReset } from 'lucide-react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { message as toast } from '../../store/toastStore.js';
import { ATTENTION_PRIORITIES, attentionActionPayload, attentionView, groupAttentionByPriority } from './attentionModel.js';
import './AttentionSection.css';

const REFRESH_INTERVAL_MS = 30_000;

export default function AttentionSection({ navigateTo }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState('');

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

  const items = useMemo(() => summary?.section?.items || [], [summary]);
  const groups = useMemo(() => groupAttentionByPriority(items), [items]);
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

  return (
    <section className="attention-section" aria-busy={loading}>
      <header className="attention-section-header">
        <div>
          <div className="attention-section-kicker"><BellRing size={15} /> Attention</div>
          <h3>优先处理需要人工介入的事项</h3>
          <p>等待审批、阻塞、失败、等待输入和待验收事项按确定性优先级排列。</p>
        </div>
        <div className="attention-section-header-actions">
          {summary?.section?.freshness?.is_stale ? <span className="attention-freshness"><AlertTriangle size={13} /> 数据可能过期</span> : null}
          <span className="attention-count">{summary?.section?.counts?.total ?? items.length}</span>
          <button aria-label="刷新 Attention" disabled={loading} onClick={() => load()} type="button"><RefreshCw className={loading ? 'is-spinning' : ''} size={15} /></button>
        </div>
      </header>

      {error ? <State error={error} onRetry={() => load()} /> : loading && !summary ? <State loading /> : items.length === 0 ? <State /> : (
        <div className="attention-priority-groups">
          {ATTENTION_PRIORITIES.map(priority => groups[priority].length > 0 ? (
            <div className="attention-priority-group" data-priority={priority} key={priority}>
              <div className="attention-priority-heading"><strong>{priority.toUpperCase()}</strong><span>{groups[priority].length} 项</span></div>
              {groups[priority].map(item => <AttentionCard item={item} key={item.id} navigateTo={navigateTo} onSubmit={submit} submitting={submitting} />)}
            </div>
          ) : null)}
        </div>
      )}
    </section>
  );
}

function AttentionCard({ item, navigateTo, onSubmit, submitting }) {
  const view = attentionView(item);
  const pending = (action) => submitting === `${item.id}:${action}`;
  return <article className={`attention-card ${view.tone}`}>
    <div className="attention-card-topline"><span>{view.typeLabel}</span><span>{view.statusLabel}</span></div>
    <strong>{item.summary}</strong>
    <p>{view.actionLabel}</p>
    <div className="attention-card-actions">
      {view.canAcknowledge ? <button disabled={Boolean(submitting)} onClick={() => onSubmit(item, 'acknowledge')} type="button"><Check size={13} /> {pending('acknowledge') ? '提交中…' : '确认'}</button> : null}
      {view.canSnooze ? <button disabled={Boolean(submitting)} onClick={() => onSubmit(item, 'snooze')} type="button"><TimerReset size={13} /> {pending('snooze') ? '提交中…' : '暂停 1 小时'}</button> : null}
      {item.links?.view === '#/attention-inbox' ? (
        <button className="open" onClick={() => navigateTo?.('attention-inbox')} type="button">打开来源 <ArrowUpRight size={13} /></button>
      ) : (
        <a className="open" href={item.links?.self} rel="noreferrer noopener" target="_blank">打开来源 <ArrowUpRight size={13} /></a>
      )}
    </div>
  </article>;
}

function State({ error = '', loading = false, onRetry }) {
  if (error) return <div className="attention-state error" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={onRetry} type="button">重试</button></div>;
  if (loading) return <div className="attention-state"><RefreshCw className="is-spinning" size={20} /><strong>正在读取 Attention…</strong></div>;
  return <div className="attention-state"><BellRing size={22} /><strong>当前没有需要关注的事项</strong><span>新的审批、阻塞、失败、输入或验收事项会实时出现在这里。</span></div>;
}
