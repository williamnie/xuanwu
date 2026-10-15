export const INBOX_SOURCES = ['human_review', 'preparing', 'failed_work', 'attention'];
export const inboxInitialState = () => ({ items: [], total: null, counts: {}, complete: null, failedSources: [], cursor: null, error: null, loading: true, loadingMore: false });

export function isInboxRefreshEvent(event) {
  return /^(issue|approval|pi|attention)\./.test(event?.type || '');
}

// One owner for pagination, invalidation and debouncing. Invalidate immediately
// on an event, before the debounce expires, so an old page cannot append meanwhile.
export function createInboxController({ fetchPage, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = inboxInitialState();
  let active = null;
  let generation = 0;
  let timer = null;
  let disposed = false;
  const publish = patch => {
    state = { ...state, ...patch };
    if (!disposed) onChange(state);
  };
  const invalidate = () => {
    generation += 1;
    const request = active;
    active = null;
    request?.abort();
  };
  const clearScheduled = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const read = async append => {
    if (disposed || (append && (active || timer !== null || !state.cursor))) return;
    if (!append) { clearScheduled(); invalidate(); }
    const version = generation;
    const controller = new AbortController();
    active = controller;
    publish({ error: null, loading: !append, loadingMore: append });
    try {
      const page = await fetchPage({ limit: 20, ...(append ? { cursor: state.cursor } : {}) }, { signal: controller.signal });
      if (disposed || version !== generation || active !== controller) return;
      validatePage(page);
      const items = append ? [...new Map([...state.items, ...page.items].map(item => [item.key, item])).values()] : page.items;
      publish({
        items, total: page.total, counts: page.counts, cursor: page.next_cursor,
        // A recovered later page cannot fill a missing earlier source. Keep the
        // partial warning until a fresh first-page read succeeds.
        complete: append ? state.complete && page.complete : page.complete,
        failedSources: append ? [...new Set([...state.failedSources, ...page.failed_sources])] : page.failed_sources,
      });
    } catch (error) {
      if (!disposed && version === generation && active === controller && error?.name !== 'AbortError') publish({ error });
    } finally {
      if (!disposed && version === generation && active === controller) {
        active = null;
        publish({ loading: false, loadingMore: false });
      }
    }
  };
  return {
    refresh: () => read(false),
    loadMore: () => read(true),
    event: event => {
      if (disposed || !isInboxRefreshEvent(event)) return;
      invalidate(); clearScheduled();
      publish({ loading: true, loadingMore: false });
      timer = setTimer(() => { timer = null; void read(false); }, 500);
    },
    dispose: () => { disposed = true; clearScheduled(); invalidate(); },
  };
}

function validatePage(page) {
  if (page?.contract !== 'xw.command-center.inbox.v1' || !Array.isArray(page.items)
    || !Number.isInteger(page.total) || page.total < 0 || typeof page.complete !== 'boolean'
    || !Array.isArray(page.failed_sources) || page.failed_sources.some(source => !INBOX_SOURCES.includes(source))
    || (page.complete && page.failed_sources.length > 0) || (!page.complete && page.failed_sources.length === 0)
    || !(page.next_cursor === null || typeof page.next_cursor === 'string')
    || !page.counts || page.items.some(item => !item?.key || !INBOX_SOURCES.includes(item.source))) {
    throw new Error('Invalid inbox response');
  }
}
