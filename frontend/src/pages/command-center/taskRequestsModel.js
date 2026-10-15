import { workRowActions } from '../work/workActions.js';

// E1 owns membership, ordering and canonical keys. Never hydrate per-card details
// or regroup across source types, even when several cards refer to the same task.
export function taskRequestCards(items = [], t = key => key) {
  return items.map(item => {
    const base = { key: item.key, work: item.work };
    if (item.source === 'attention') return { ...base, kind: 'attention', attention: item.attention };
    if (item.source === 'human_review' && item.actionable && item.request?.status === 'open') {
      return { ...base, kind: 'review', request: { ...item.request, id: item.review_request_id, revision: item.review_revision } };
    }
    if (item.source === 'failed_work') return {
      ...base, kind: 'failed', label: 'FAILED', tone: 'error', detail: t('inbox.failedDetail'),
      retry: workRowActions(item.work?.status).find(action => action.id === 'retry'),
    };
    return { ...base, kind: 'preparing', label: 'PREPARING', tone: 'idle', detail: t('inbox.preparing') };
  });
}

export function inboxFailure(source, error, t) {
  const invalidated = [404, 409, 410].includes(error?.status);
  const expired = error?.status === 410 || (invalidated && /expired|过期/i.test(error?.message || ''));
  const handled = error?.status === 404 || (invalidated && /already|terminal|已.*处理|已.*结束|不再|已.*回复|closed/i.test(error?.message || ''));
  const reason = expired ? 'expired' : handled ? 'handled' : 'changed';
  return { invalidated, message: invalidated ? t(`inbox.${source}.${reason}`) : error?.message || t(`inbox.${source}.failed`) };
}

export function inboxIsEmpty(state) {
  return !state.loading && !state.loadingMore && !state.error && state.complete === true && state.total === 0;
}
