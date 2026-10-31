import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workApi } from '../../api/work.js';
import { eventsApi } from '../../api/events.js';
import { selectProjects, selectWorkSummary, useDataStore } from '../../store/dataStore';
import { message } from '../../store/toastStore.js';
import { filterWorkBoardItems, groupWorksByStatus, laneScrollDecision, WORK_BOARD_STATUSES } from '../workBoardModel.js';
import { useI18n } from '../../i18n/context.js';
import { mergeWorks, mergeOperationalSnapshot, mergeRefreshedLanePages, normalizeBoardSnapshot, normalizeLanePage } from './workKanbanModel.js';

const EMPTY_FILTERS = {
  attention: '',
  delivery: '',
  project: '',
  query: '',
  status: '',
  type: '',
};

const WORK_REFRESH_INTERVAL_MS = 5_000;
const OPERATIONAL_STATUSES = ['triage', 'todo', 'in_progress', 'needs_user', 'failed'];
const HISTORY_STATUSES = ['done', 'cancelled'];
const BOARD_RECONCILE_EVENT_TYPES = new Set(['issue.created', 'issue.deleted', 'issue.status_changed', 'issue.updated']);

export default function useWorkKanbanData({ projectId, query, refreshToken, source }) {
  const { t } = useI18n();
  const projects = useDataStore(selectProjects);
  const workSummary = useDataStore(selectWorkSummary);
  const selectedWorkId = '';
  const [works, setWorks] = useState([]);
  const filters = useMemo(() => ({ ...EMPTY_FILTERS, project: projectId, query }), [projectId, query]);
  const [loading, setLoading] = useState(true);
  const [loadingMoreStatus, setLoadingMoreStatus] = useState('');
  const [error, setError] = useState('');
  const [lanePages, setLanePages] = useState({});
  const boardRequest = useRef(null);
  const boardController = useRef(null);
  const workSummaryRef = useRef(workSummary);
  const loadMoreController = useRef(null);
  const loadingMoreStatusRef = useRef('');
  const laneScrollArmed = useRef(new Map(WORK_BOARD_STATUSES.map(status => [status, true])));

  const loadBoard = useCallback(async ({ silent = false } = {}) => {
    if (selectedWorkId || (silent && loadingMoreStatusRef.current)) return undefined;
    if (boardRequest.current) {
      await boardRequest.current.catch(() => {});
      return undefined;
    }

    if (!silent) {
      loadMoreController.current?.abort();
      loadingMoreStatusRef.current = '';
      laneScrollArmed.current = new Map(WORK_BOARD_STATUSES.map(status => [status, true]));
      setLoadingMoreStatus('');
      setLoading(true);
      setError('');
    }

    const controller = new AbortController();
    boardController.current = controller;
    const pending = workApi.getWorkBoard({
      statuses: OPERATIONAL_STATUSES,
      ...(source ? { source, projectId, query } : {}),
    }, { signal: controller.signal });
    boardRequest.current = pending;
    try {
      const boardResponse = await pending;
      if (controller.signal.aborted) return undefined;
      const snapshot = normalizeBoardSnapshot(boardResponse, workSummaryRef.current, Boolean(source));
      setWorks(current => mergeOperationalSnapshot(current, snapshot.items));
      setLanePages(current => mergeRefreshedLanePages(current, snapshot.lanePages));
      setError('');
    } catch (loadError) {
      if (!silent && loadError?.name !== 'AbortError') setError(loadError.message || t('board.loadFailed'));
    } finally {
      if (boardRequest.current === pending) {
        boardRequest.current = null;
        if (!silent) setLoading(false);
      }
      if (boardController.current === controller) boardController.current = null;
    }
    return undefined;
  }, [selectedWorkId, source, projectId, query, t]);

  useEffect(() => {
    workSummaryRef.current = workSummary;
    if (source) return;
    setLanePages(current => ({
      ...current,
      ...Object.fromEntries(HISTORY_STATUSES.map(status => [status, {
        ...normalizeLanePage({ total: workSummary.counts?.[status] || 0 }, 20, 'not_loaded'),
        ...current[status],
        total: workSummary.counts?.[status] || 0,
      }]))
    }));
  }, [workSummary, source]);

  useEffect(() => {
    if (selectedWorkId) {
      setLoading(false);
      return undefined;
    }
    void loadBoard();
    return () => {
      const controller = boardController.current;
      boardController.current = null;
      boardRequest.current = null;
      controller?.abort();
    };
  }, [loadBoard, selectedWorkId]);

  useEffect(() => {
    if (selectedWorkId) return undefined;
    let timer = 0;
    const unsubscribe = eventsApi.subscribeToEvents(event => {
      if (timer || !BOARD_RECONCILE_EVENT_TYPES.has(event.type)) return;
      timer = window.setTimeout(() => {
        timer = 0;
        void loadBoard({ silent: true });
      }, 500);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [loadBoard, selectedWorkId]);

  useEffect(() => {
    if (selectedWorkId) return undefined;
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await loadBoard({ silent: true });
        if (!stopped) schedule();
      }, WORK_REFRESH_INTERVAL_MS);
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [loadBoard, selectedWorkId]);

  useEffect(() => () => loadMoreController.current?.abort(), []);

  const loadMore = useCallback(async (status) => {
    const lane = lanePages[status];
    if (
      selectedWorkId || loading || loadingMoreStatusRef.current ||
      !lane || !lane.hasMore
    ) return;
    const controller = new AbortController();
    loadMoreController.current = controller;
    loadingMoreStatusRef.current = status;
    setLoadingMoreStatus(status);
    try {
      const response = await workApi.getWorks({
        cursor: lane.nextCursor,
        page: lane.nextCursor ? 1 : lane.page + 1,
        pageSize: lane.pageSize,
        statuses: [status],
        ...(source ? { source, projectId, query } : {}),
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setWorks(current => mergeWorks(current, response?.items || []));
      const nextLane = normalizeLanePage(response, lane.pageSize, 'loaded');
      setLanePages(current => ({ ...current, [status]: nextLane }));
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') message.error(loadError.message || t('board.loadMoreFailed'));
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        loadingMoreStatusRef.current = '';
        setLoadingMoreStatus('');
      }
    }
  }, [lanePages, loading, selectedWorkId, source, projectId, query, t]);

  const loadHistory = useCallback(async (status) => {
    if (!HISTORY_STATUSES.includes(status) || ['loading', 'loaded'].includes(lanePages[status]?.loadState)) return;
    setLanePages(current => ({
      ...current,
      [status]: { ...current[status], loadState: 'loading' },
    }));
    try {
      const response = await workApi.getWorks({ pageSize: 20, statuses: [status], ...(source ? { source, projectId, query } : {}) });
      setWorks(current => mergeWorks(current, response?.items || []));
      setLanePages(current => ({
        ...current,
        [status]: normalizeLanePage(response, 20, 'loaded'),
      }));
    } catch (loadError) {
      setLanePages(current => ({
        ...current,
        [status]: { ...current[status], loadState: 'error' },
      }));
      message.error(loadError.message || t('board.loadFailed'));
    }
  }, [lanePages, source, projectId, query, t]);

  useEffect(() => {
    if (!filters.query.trim()) return;
    HISTORY_STATUSES.forEach(status => void loadHistory(status));
  }, [filters.query, loadHistory]);

  const handleColumnScroll = useCallback((event, status) => {
    const target = event.currentTarget;
    const decision = laneScrollDecision({
      armed: laneScrollArmed.current.get(status) !== false,
      clientHeight: target.clientHeight,
      scrollHeight: target.scrollHeight,
      scrollTop: target.scrollTop,
    });
    laneScrollArmed.current.set(status, decision.armed);
    if (decision.load) void loadMore(status);
  }, [loadMore]);

  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects]);
  const filteredWorks = useMemo(
    () => filterWorkBoardItems(works, filters),
    [filters, works],
  );
  const groupedWorks = useMemo(() => groupWorksByStatus(filteredWorks), [filteredWorks]);
  const refresh = useCallback(() => {
    void loadBoard();
  }, [loadBoard]);

  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    refresh();
  }, [refresh, refreshToken]);
  return { works, error, loading, lanePages, loadingMoreStatus, loadMore, loadHistory, handleColumnScroll, projectNames, groupedWorks, refresh };
}
