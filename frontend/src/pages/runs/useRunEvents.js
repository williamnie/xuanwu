import { useCallback, useEffect, useState } from 'react';

import { runsApi } from '../../api/runs.js';

import { RUN_EVENT_PAGE_SIZE, RUN_EVENT_SCAN_LIMIT, eventPageCursor, eventsWithinAttempt, mergeRunEventPages, runEventInitialBeforeId } from './runDetailModel.js';

export function useRunEvents({ active, attempt, issueId, run, types }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState('');
  const [scanned, setScanned] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const typeKey = types.join(',');
  const initialBeforeId = runEventInitialBeforeId(run, attempt);

  useEffect(() => {
    setItems([]);
    setCursor('');
    setScanned(0);
    setHasOlder(false);
    setError('');
    if (!active || !issueId) return undefined;
    let alive = true;
    setLoading(true);
    runsApi.getRunEvents(issueId, {
      beforeId: initialBeforeId,
      limit: RUN_EVENT_PAGE_SIZE,
      types: typeKey ? typeKey.split(',') : [],
    }).then(page => {
      if (!alive) return;
      const raw = Array.isArray(page) ? page : [];
      setItems(eventsWithinAttempt(raw, attempt, run));
      setCursor(eventPageCursor(raw));
      setScanned(raw.length);
      setHasOlder(raw.length === RUN_EVENT_PAGE_SIZE && raw.length < RUN_EVENT_SCAN_LIMIT);
    }).catch(loadError => {
      if (alive) setError(loadError.message || '加载执行事件失败');
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [active, attempt, initialBeforeId, issueId, reloadToken, run, typeKey]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || scanned >= RUN_EVENT_SCAN_LIMIT) return;
    const remaining = RUN_EVENT_SCAN_LIMIT - scanned;
    const limit = Math.min(RUN_EVENT_PAGE_SIZE, remaining);
    setLoadingMore(true);
    try {
      const page = await runsApi.getRunEvents(issueId, {
        beforeId: cursor,
        limit,
        types: typeKey ? typeKey.split(',') : [],
      });
      const raw = Array.isArray(page) ? page : [];
      setItems(current => mergeRunEventPages(current, eventsWithinAttempt(raw, attempt, run)));
      setCursor(eventPageCursor(raw));
      const nextScanned = scanned + raw.length;
      setScanned(nextScanned);
      setHasOlder(raw.length === limit && nextScanned < RUN_EVENT_SCAN_LIMIT);
      setError('');
    } catch (loadError) {
      setError(loadError.message || '加载更早的执行事件失败');
    } finally {
      setLoadingMore(false);
    }
  }, [attempt, cursor, issueId, loadingMore, run, scanned, typeKey]);

  return {
    error,
    hasOlder,
    items,
    loadMore,
    loading,
    loadingMore,
    refresh: () => setReloadToken(value => value + 1),
    scanned,
  };
}

