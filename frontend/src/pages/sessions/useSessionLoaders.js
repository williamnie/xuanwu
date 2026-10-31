import { useRef, useCallback, useEffect } from 'react';
import { runsApi } from '../../api/runs.js';
import { mergeRefreshedSessions, mergeSessions, isSessionRunning, chronologicalTurns, syncSessionRuntimeInList, normalizePendingApprovals, mergeTurnPages } from './sessionPageRuntime';
import { message as toast } from '../../store/toastStore';
import { syncApprovalsForSession } from './approvalQueue';

const PAGE_SIZE = 50;
const SESSION_TURN_PAGE_SIZE = 20;
export default function useSessionLoaders({
  selectedId,
  setLoading,
  setSessions,
  setCursor,
  setSelectedId,
  autoSelectFirstSessionRef,
  cursor,
  loadingMore,
  setLoadingMore,
  setDetailLoading,
  setSelectedSession,
  setTurnCursor,
  setDetailError,
  loadTranscriptPage,
  selectedIdRef,
  setSessionRunning,
  setApprovalQueue,
  turnCursor,
  setTurnsLoading,
  showSidebar,
  setLastProjectId,
}) {
  const lastSelectedIdRef = useRef(selectedId);
  const turnsRequestRef = useRef(null);
  const detailRequestRef = useRef(null);
  const loadFirstPage = useCallback(async ({
    silent = false,
    preserveLoaded = false,
    reportErrors = true,
  } = {}) => {
    if (!silent) setLoading(true);
    try {
      const result = await runsApi.getSessions({ limit: PAGE_SIZE });
      const data = result.data || [];
      const nextCursor = result.nextCursor || '';
      setSessions((current) => (
        preserveLoaded ? mergeRefreshedSessions(current, data) : data
      ));
      setCursor(nextCursor);
      setSelectedId((current) => current || (autoSelectFirstSessionRef.current ? data[0]?.id || '' : ''));
      autoSelectFirstSessionRef.current = false;
    } catch (err) {
      if (reportErrors) toast.error(err.message || '加载 provider sessions 失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [autoSelectFirstSessionRef, setCursor, setLoading, setSelectedId, setSessions]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await runsApi.getSessions({ limit: PAGE_SIZE, cursor });
      setSessions((prev) => mergeSessions(prev, result.data || []));
      setCursor(result.nextCursor || '');
    } catch (err) {
      toast.error(err.message || '继续加载 sessions 失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, setCursor, setLoadingMore, setSessions]);

  const loadSelected = useCallback(async (isSwitching = false, { refreshTranscript = false } = {}) => {
    if (!selectedId) return;
    if (detailRequestRef.current?.requestId === selectedId) return detailRequestRef.current.promise;
    if (isSwitching) {
      setDetailLoading(true);
      setSelectedSession(null);
      setTurnCursor('');
      setDetailError('');
    }
    const requestId = selectedId;
    const promise = (async () => {
      const [detail, turnPage] = await Promise.all([
        runsApi.getSession(requestId),
        refreshTranscript
          ? (loadTranscriptPage || runsApi.getSessionTurns)(requestId, { limit: SESSION_TURN_PAGE_SIZE })
          : Promise.resolve(null),
      ]);
      if (selectedIdRef.current !== requestId) return;
      const running = isSessionRunning(detail);
      const pageTurns = turnPage ? chronologicalTurns(turnPage.data) : null;
      setSelectedSession((current) => ({
        ...detail,
        turns: pageTurns ?? (current?.id === requestId ? current.turns || [] : []),
      }));
      if (turnPage) setTurnCursor(turnPage.nextCursor || '');
      setDetailError('');
      setSessionRunning(running);
      setSessions((prev) => syncSessionRuntimeInList(prev, detail, running));
      setApprovalQueue((current) => syncApprovalsForSession(
        current,
        requestId,
        normalizePendingApprovals(detail.pending_approvals),
      ));
    })();
    detailRequestRef.current = { promise, requestId };
    try {
      await promise;
    } catch (err) {
      if (selectedIdRef.current !== requestId) return;
      const message = err.message || '读取 session 详情失败';
      setDetailError(message);
      toast.error(message);
    } finally {
      if (detailRequestRef.current?.promise === promise) detailRequestRef.current = null;
      if (selectedIdRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }, [loadTranscriptPage, selectedId, selectedIdRef, setApprovalQueue, setDetailError, setDetailLoading, setSelectedSession, setSessionRunning, setSessions, setTurnCursor]);

  const loadOlderTurns = useCallback(async () => {
    if (!selectedId || !turnCursor || turnsRequestRef.current) return;
    const requestId = selectedId;
    setTurnsLoading(true);
    const promise = (loadTranscriptPage || runsApi.getSessionTurns)(requestId, {
      cursor: turnCursor,
      limit: SESSION_TURN_PAGE_SIZE,
    });
    turnsRequestRef.current = promise;
    try {
      const page = await promise;
      if (selectedIdRef.current !== requestId) return;
      const older = chronologicalTurns(page.data);
      setSelectedSession((current) => current?.id === requestId
        ? { ...current, turns: mergeTurnPages(older, current.turns || []) }
        : current);
      setTurnCursor(page.nextCursor || '');
    } catch (err) {
      if (selectedIdRef.current === requestId) toast.error(err.message || '读取更早记录失败');
    } finally {
      if (turnsRequestRef.current === promise) turnsRequestRef.current = null;
      if (selectedIdRef.current === requestId) setTurnsLoading(false);
    }
  }, [loadTranscriptPage, selectedId, selectedIdRef, setSelectedSession, setTurnCursor, setTurnsLoading, turnCursor]);

  useEffect(() => {
    if (showSidebar) loadFirstPage();
    else setLoading(false);
  }, [loadFirstPage, setLoading, showSidebar]);
  useEffect(() => {
    if (!showSidebar) return undefined;
    let alive = true;
    runsApi.getSessionPreferences()
      .then((prefs) => {
        if (alive) setLastProjectId(prefs?.last_project_id || '');
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [setLastProjectId, showSidebar]);

  useEffect(() => {
    const isSwitching = lastSelectedIdRef.current !== selectedId;
    lastSelectedIdRef.current = selectedId;
    loadSelected(isSwitching, { refreshTranscript: true });
  }, [selectedId, loadSelected]);

  return { loadFirstPage, loadMore, loadSelected, loadOlderTurns };
}
