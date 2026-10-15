import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, RefreshCw } from 'lucide-react';
import ModalOverlay from '../../components/ModalOverlay.jsx';
import { useI18n } from '../../i18n/context.js';
import { message } from '../../store/toastStore.js';
import { HumanReviewCard } from '../work/HumanReview.jsx';
import { useHumanReview } from '../work/useHumanReview.jsx';
import { executeWorkMove } from '../work/workActions.js';
import { AttentionCard, ApprovalDetail } from './AttentionSection.jsx';
import { inboxFailure, inboxIsEmpty, taskRequestCards } from './taskRequestsModel.js';
import { useInbox } from './useInbox.js';
import { useAttentionActions } from './useAttentionActions.js';
import './TaskRequestsSection.css';

// Membership, ordering and totals come exclusively from E1. Each card retains
// its original command adapter: human review, task retry, or Attention.
export default function TaskRequestsSection({ navigateTo, onCreate, onSummaryChange }) {
  const { t } = useI18n();
  const { state, refresh, loadMore } = useInbox();
  const [busyId, setBusyId] = useState('');
  const cards = taskRequestCards(state.items, t);
  const review = useHumanReview({ onSubmitted: refresh, classifyError: error => inboxFailure('review', error, t) });
  const attention = useAttentionActions(refresh);
  useEffect(() => {
    onSummaryChange?.(state.total === null ? null : { total: state.total, complete: state.complete && !state.error });
  }, [state.total, state.complete, state.error, onSummaryChange]);

  const retry = async card => {
    if (busyId || !card.retry) return;
    setBusyId(card.work.id);
    try {
      await executeWorkMove(card.work, card.retry.target);
      message.success(t('work.requeued'));
      await refresh();
    } catch (error) {
      const failure = inboxFailure('task', error, t);
      message.error(failure.message);
      if (failure.invalidated) await refresh();
    } finally { setBusyId(''); }
  };
  const approvalOpen = attention.approval.loading || attention.approval.error || attention.approval.detail;

  return <section className="task-requests e2b-terminal-window" aria-busy={state.loading || state.loadingMore}>
    <header className="task-requests-header e2b-window-header">
      <div className="e2b-window-title"><span className="e2b-window-tag">01 INBOX</span><h2>{t('inbox.title')}</h2></div>
      <div className="e2b-window-meta">
        <span className="e2b-meta-code font-mono">{state.total === null ? '—' : t(state.complete && !state.error ? 'inbox.total' : 'inbox.partialTotal', { count: state.total })}</span>
        <button aria-label={t('inbox.refresh')} className="task-requests-refresh" disabled={state.loading} onClick={refresh} type="button"><RefreshCw className={state.loading ? 'is-spinning' : ''} size={14} /></button>
      </div>
    </header>
    {state.error ? <div className="task-requests-state is-error" role="alert"><AlertTriangle size={14} /><span>{t('inbox.loadFailed')}</span><button className="btn btn-secondary" onClick={refresh} type="button">{t('inbox.retry')}</button></div> : null}
    {state.complete === false ? <div className="task-requests-state is-error" role="alert"><AlertTriangle size={14} /><span>{t('inbox.partial', { sources: state.failedSources.map(source => t(`inbox.source.${source}`)).join(' / ') })}</span><button className="btn btn-secondary" onClick={refresh} type="button">{t('inbox.retry')}</button></div> : null}
    {state.loading && cards.length === 0 ? <div className="task-requests-state"><RefreshCw className="is-spinning" size={14} />{t('inbox.loading')}</div> : null}
    {inboxIsEmpty(state) ? <div className="task-requests-empty"><CheckCircle2 size={34} /><p>{t('inbox.empty')}</p><button className="btn btn-secondary" onClick={onCreate} type="button">{t('board.newWork')}</button></div> : null}
    {cards.length > 0 ? <ul className="task-requests-list">
      {cards.map(card => <li key={card.key}>
        {card.kind === 'review' ? <div className="task-request-review">
          <button className="task-request-title" onClick={() => navigateTo('tasks', card.work.id)} type="button">{card.work.title} <ArrowRight size={13} /></button>
          <HumanReviewCard compact disabled={review.submitting} onSelect={action => review.select(card.work, card.request, action)} request={card.request} />
        </div> : card.kind === 'attention' ? <AttentionCard item={card.attention} onReviewApproval={attention.review} onSubmit={attention.submit} submitting={attention.submitting} /> : <article className="ds-request-card" data-tone={card.tone}>
          <span className="dot" /><div><div className="kind">{card.label}</div><div className="title">{card.work.title}</div><div className="detail">{card.detail}</div></div>
          <div className="actions">
            {card.retry ? <button className="btn btn-secondary" disabled={Boolean(busyId)} onClick={() => retry(card)} type="button">{busyId === card.work.id ? t('inbox.submitting') : t('inbox.retry')}</button> : null}
            <button className="btn btn-secondary" onClick={() => navigateTo('tasks', card.work.id)} type="button">{t('inbox.openTask')}</button>
          </div>
        </article>}
      </li>)}
    </ul> : null}
    {state.cursor ? <button className="task-requests-more" disabled={state.loading || state.loadingMore} onClick={loadMore} type="button">{state.loadingMore ? t('inbox.loading') : t('inbox.loadMore')} <ArrowRight size={13} /></button> : null}
    {review.dialog}
    {approvalOpen ? <ModalOverlay className="inbox-approval-overlay"><ApprovalDetail approval={attention.approval} onClose={attention.close} onResolve={attention.resolve} submitting={attention.submitting} /></ModalOverlay> : null}
  </section>;
}
