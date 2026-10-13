import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, RefreshCw } from 'lucide-react';
import { eventsApi } from '../../api/events.js';
import { workApi } from '../../api/work.js';
import { useI18n } from '../../i18n/context.js';
import { message } from '../../store/toastStore.js';
import { HumanReviewCard } from '../work/HumanReview.jsx';
import { useHumanReview } from '../work/useHumanReview.jsx';
import { executeWorkMove } from '../work/workActions.js';
import { taskRequestCards } from './taskRequestsModel.js';
import './TaskRequestsSection.css';

const SHOWN_PER_STATUS = 5;
const REFRESH_EVENT_TYPES = new Set(['issue.created', 'issue.deleted', 'issue.status_changed', 'issue.updated']);

// 首页“待你处理”中与任务相关的请求：人工审核（就地回复）与失败任务（就地重试）。
// 每类请求走各自原有的提交接口；数量超过展示上限时明确提示，而不是显示“没有了”。
export default function TaskRequestsSection({ navigateTo, onCreate }) {
  const { t } = useI18n();
  const [state, setState] = useState({ cards: [], error: '', hidden: 0, loading: true });
  const [busyId, setBusyId] = useState('');
  const version = useRef(0);

  const load = useCallback(async ({ silent = false } = {}) => {
    const current = ++version.current;
    if (!silent) setState(previous => ({ ...previous, loading: true }));
    try {
      const [needsUser, failed] = await Promise.all([
        workApi.getWorks({ pageSize: SHOWN_PER_STATUS, statuses: ['needs_user'] }),
        workApi.getWorks({ pageSize: SHOWN_PER_STATUS, statuses: ['failed'] }),
      ]);
      // 只为已展示的待你处理任务（≤5）读取详情，拿到后端的请求类型；不做逐行全量查询。
      const details = await Promise.allSettled((needsUser?.items || []).map(work => workApi.getWork(work.id)));
      if (current !== version.current) return;
      const decisions = new Map(details.flatMap(result => result.status === 'fulfilled' && result.value?.work
        ? [[result.value.work.id, result.value.decision || null]]
        : []));
      const cards = taskRequestCards({ decisions, failed: failed?.items || [], needsUser: needsUser?.items || [] });
      const hidden = Math.max(0, Number(needsUser?.total || 0) - (needsUser?.items || []).length)
        + Math.max(0, Number(failed?.total || 0) - (failed?.items || []).length);
      setState({ cards, error: '', hidden, loading: false });
    } catch (loadError) {
      if (current === version.current) setState(previous => ({ ...previous, error: loadError.message || '读取待处理任务失败', loading: false }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let timer = 0;
    const unsubscribe = eventsApi.subscribeToEvents(event => {
      if (timer || !REFRESH_EVENT_TYPES.has(event?.type)) return;
      timer = window.setTimeout(() => { timer = 0; void load({ silent: true }); }, 500);
    });
    return () => { window.clearTimeout(timer); unsubscribe(); };
  }, [load]);

  const review = useHumanReview({ onSubmitted: () => load({ silent: true }) });

  const retry = async (work) => {
    setBusyId(work.id);
    try {
      await executeWorkMove(work, 'in_progress');
      message.success(t('work.requeued'));
      await load({ silent: true });
    } catch (actionError) {
      message.error(actionError.status === 409 ? '任务已更新，请核对最新状态' : actionError.message || t('work.actionFailed'));
      if (actionError.status === 409) await load({ silent: true });
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="task-requests e2b-terminal-window" aria-busy={state.loading}>
      <header className="task-requests-header e2b-window-header">
        <div className="e2b-window-dots">
          <span className="e2b-dot red" />
          <span className="e2b-dot yellow" />
          <span className="e2b-dot green" />
        </div>
        <div className="e2b-window-title">
          <span className="e2b-window-tag">01 TASK_REQUESTS</span>
          <h2>待你处理</h2>
        </div>
        <div className="e2b-window-meta">
          <span className="e2b-meta-code font-mono">[QUEUE: REVIEW_RETRY]</span>
          <button aria-label="刷新待处理任务" className="task-requests-refresh" disabled={state.loading} onClick={() => load()} type="button">
            <RefreshCw className={state.loading ? 'is-spinning' : ''} size={14} />
          </button>
        </div>
      </header>

      {state.error ? (
        <div className="task-requests-state is-error" role="alert"><AlertTriangle size={14} /><span>{state.error}</span><button className="btn btn-secondary" onClick={() => load()} type="button">重试</button></div>
      ) : state.loading && state.cards.length === 0 ? (
        <div className="task-requests-state"><RefreshCw className="is-spinning" size={14} /> 正在读取…</div>
      ) : state.cards.length === 0 ? (
        <div className="task-requests-empty">
          <CheckCircle2 size={34} />
          <p>没有需要你处理的任务</p>
          <button className="btn btn-secondary" onClick={onCreate} type="button">新建任务</button>
        </div>
      ) : (
        <ul className="task-requests-list">
          {state.cards.map(card => (
            <li key={card.key}>
              {card.kind === 'review' ? (
                <div className="task-request-review">
                  <button className="task-request-title" onClick={() => navigateTo('work', card.work.id)} type="button">{card.work.title} <ArrowRight size={12} /></button>
                  <HumanReviewCard compact disabled={review.submitting} onSelect={action => review.select(card.work, card.request, action)} request={card.request} />
                </div>
              ) : (
                <article className="ds-request-card" data-tone={card.tone}>
                  <span className="dot" />
                  <div>
                    <div className="kind">{card.label}</div>
                    <div className="title">{card.work.title}</div>
                    <div className="detail">{card.detail}</div>
                  </div>
                  <div className="actions">
                    {card.kind === 'failed' ? <button className="btn btn-secondary" disabled={Boolean(busyId)} onClick={() => retry(card.work)} type="button">{busyId === card.work.id ? '提交中…' : '重试'}</button> : null}
                    <button className="btn btn-secondary" onClick={() => navigateTo('work', card.work.id)} type="button">查看</button>
                  </div>
                </article>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.hidden > 0 ? (
        <button className="task-requests-more" onClick={() => navigateTo('work', null, '', '', { scope: 'attention' })} type="button">
          还有 {state.hidden} 个任务等你处理，在任务页查看 <ArrowRight size={13} />
        </button>
      ) : null}
      {review.dialog}
    </section>
  );
}
