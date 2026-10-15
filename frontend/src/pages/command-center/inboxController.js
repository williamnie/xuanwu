export const INBOX_SOURCES = ['human_review', 'preparing', 'failed_work', 'attention'];
export const inboxInitialState = () => ({ items: [], total: null, counts: {}, complete: null, failedSources: [], cursor: null, error: null, loading: true, loadingMore: false });

// EventBus names used by issue mutations, approvals, Attention and PI actionAudit /
// projectFindings. Conversation chunks, memories and manager cycles do not change
// the inbox and must not keep its refresh window open.
export function isInboxRefreshEvent(event) {
  // Codex provider approvals are published as codex.event + method, not approval.*.
  if (event?.type === 'codex.event') return ['approval/requested', 'approval/resolved'].includes(event.method);
  return /^(issue\.(created|deleted|status_changed|updated)|approval\..+|attention\..+|pi\.action_.+|pi\.(needs_user|issue_ready_for_acceptance|project_blocked))$/.test(event?.type || '');
}

export function createInboxController({ fetchPage, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = inboxInitialState();
  let active = null;
  let generation = 0;
  let timer = null;
  let trailingEvent = false;
  let autoPending = false;
  let morePending = false;
  let disposed = false;
  const publish = patch => {
    state = { ...state, ...patch };
    if (!disposed) onChange(state);
  };
  const invalidate = () => {
    generation += 1;
    const request = active;
    active = null;
    request?.controller.abort();
  };
  const clearScheduled = () => { if (timer !== null) clearTimer(timer); timer = null; trailingEvent = false; };
  const drain = () => {
    if (disposed || active) return;
    if (morePending) {
      morePending = false;
      if (state.cursor) { void read('more'); return; }
      publish({ loadingMore: false });
    }
    if (autoPending) { autoPending = false; void read('auto'); }
  };
  const read = async kind => {
    if (disposed) return;
    const version = generation;
    const request = { controller: new AbortController(), kind };
    active = request;
    const current = () => !disposed && version === generation && active === request;
    const target = kind === 'auto' ? Math.max(20, state.items.length) : 20;
    let cursor = kind === 'more' ? state.cursor : null;
    let items = kind === 'more' ? state.items : [];
    let complete = kind === 'more' ? state.complete : true;
    const failedSources = new Set(kind === 'more' ? state.failedSources : []);
    const cursors = new Set();
    publish({ error: null, ...(kind === 'manual' ? { loading: true } : {}), ...(kind === 'more' ? { loadingMore: true } : {}) });
    try {
      let page;
      do {
        const limit = kind === 'auto' ? Math.min(50, target - items.length) : 20;
        page = await fetchPage({ limit, ...(cursor ? { cursor } : {}) }, { signal: request.controller.signal });
        if (!current()) return;
        validatePage(page);
        items = [...new Map([...items, ...page.items].map(item => [item.key, item])).values()];
        complete = complete && page.complete;
        page.failed_sources.forEach(source => failedSources.add(source));
        cursor = page.next_cursor;
        if (cursor && cursors.has(cursor)) throw new Error('Repeated inbox cursor');
        cursors.add(cursor);
      } while (kind === 'auto' && cursor && items.length < target);
      // Publish the refreshed range atomically: never briefly collapse a long
      // list to page one while the remaining cursor pages are being read.
      publish({ items, total: page.total, counts: page.counts, cursor, complete, failedSources: [...failedSources] });
    } catch (error) {
      if (current() && error?.name !== 'AbortError') publish({ error });
    } finally {
      if (current()) {
        active = null;
        publish({ ...(kind === 'manual' ? { loading: false } : {}), ...(kind === 'more' ? { loadingMore: false } : {}) });
        drain();
      }
    }
  };
  const refreshAutomatically = () => {
    if (disposed) return;
    clearScheduled();
    autoPending = true;
    // An active refresh finishes instead of being repeatedly cancelled. Events
    // during that read coalesce into a following read, with no parallel fetches.
    drain();
  };
  const scheduleEventWindow = () => {
    if (timer !== null) { trailingEvent = true; return; }
    timer = setTimer(() => {
      timer = null;
      const followUp = trailingEvent;
      trailingEvent = false;
      refreshAutomatically();
      // One trailing window covers changes coalesced into this window. Neither
      // a burst nor a continuous stream can move the current deadline.
      if (followUp) scheduleEventWindow();
    }, 500);
  };
  return {
    refresh: () => {
      clearScheduled(); autoPending = false; morePending = false; invalidate();
      publish({ loadingMore: false });
      return read('manual');
    },
    refreshAutomatically,
    loadMore: () => {
      if (disposed || !state.cursor || state.loading || state.loadingMore) return;
      if (active) { morePending = true; publish({ loadingMore: true }); return; }
      return read('more');
    },
    event: event => {
      if (disposed || !isInboxRefreshEvent(event)) return;
      // A cursor page predating an event must not append to refreshed results.
      if (active?.kind === 'more') { invalidate(); publish({ loadingMore: false }); }
      // Fixed window from the FIRST event: later events cannot postpone it.
      scheduleEventWindow();
    },
    dispose: () => { disposed = true; autoPending = false; morePending = false; clearScheduled(); invalidate(); },
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
