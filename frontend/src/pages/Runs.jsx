import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, History } from 'lucide-react';
import { eventsApi } from '../api/events.js';
import { runsApi } from '../api/runs.js';
import TurtleLoader from '../components/TurtleLoader';
import { message as toast } from '../store/toastStore';
import Sessions from './Sessions.jsx';
import RunContextBar from './runs/RunContextBar.jsx';
import RunDetail from './runs/RunDetail.jsx';
import RunSidebar from './runs/RunSidebar.jsx';
import {
  RUN_REFRESH_EVENT_TYPES,
  mergeRunPages,
  runProviderSessionRef,
} from './runs/runPageModel.js';
import './runs/Runs.css';

const RUN_PAGE_SIZE = 30;
const RUN_RECONCILE_INTERVAL_MS = 5_000;

export default function Runs({ navigateTo, onMobileSidebarAction, onPageContextChange, selectedRunId = '', selectedSessionId = '' }) {
  const [runs, setRuns] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [surface, setSurface] = useState(selectedSessionId ? 'compat-session' : 'run');
  const [activeRunId, setActiveRunId] = useState(selectedRunId);
  const [runDetail, setRunDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailReloadToken, setDetailReloadToken] = useState(0);
  const listRequest = useRef(null);
  const listController = useRef(null);
  const loadMoreController = useRef(null);

  const loadFirstPage = useCallback(async ({ silent = false } = {}) => {
    if (listRequest.current) {
      await listRequest.current.catch(() => {});
      return undefined;
    }
    if (!silent) setLoading(true);
    const controller = new AbortController();
    listController.current = controller;
    setRefreshing(true);
    const pending = runsApi.getRuns(
      { page: 1, pageSize: RUN_PAGE_SIZE },
      { signal: controller.signal },
    );
    listRequest.current = pending;
    try {
      const response = await pending;
      const firstPage = response?.items || [];
      setRuns(current => silent ? mergeRunPages(firstPage, current) : firstPage);
      if (!silent) setPage(Number(response?.page || 1));
      setTotalPages(Number(response?.total_pages || 0));
      setError('');
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') setError(loadError.message || '加载 Runs 失败');
    } finally {
      if (listRequest.current === pending) {
        listRequest.current = null;
        setRefreshing(false);
        if (!silent) setLoading(false);
      }
      if (listController.current === controller) listController.current = null;
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || page >= totalPages) return;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true);
    try {
      const response = await runsApi.getRuns(
        { page: page + 1, pageSize: RUN_PAGE_SIZE },
        { signal: controller.signal },
      );
      setRuns(current => mergeRunPages(current, response?.items || []));
      setPage(Number(response?.page || page + 1));
      setTotalPages(Number(response?.total_pages || totalPages));
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') toast.error(loadError.message || '继续加载 Runs 失败');
    } finally {
      if (loadMoreController.current === controller) loadMoreController.current = null;
      setLoadingMore(false);
    }
  }, [loadingMore, page, totalPages]);

  useEffect(() => {
    loadFirstPage();
    return () => {
      const controller = listController.current;
      listController.current = null;
      listRequest.current = null;
      controller?.abort();
      loadMoreController.current?.abort();
    };
  }, [loadFirstPage]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await loadFirstPage({ silent: true });
        if (!stopped) schedule();
      }, RUN_RECONCILE_INTERVAL_MS);
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [loadFirstPage]);

  useEffect(() => {
    let timer = 0;
    const unsubscribe = eventsApi.subscribeToEvents((event) => {
      if (!RUN_REFRESH_EVENT_TYPES.has(event.type) || timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        loadFirstPage({ silent: true });
        setDetailReloadToken(value => value + 1);
      }, 250);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [loadFirstPage]);

  useEffect(() => {
    if (selectedSessionId) {
      setSurface('compat-session');
      setActiveRunId('');
      return;
    }
    setSurface('run');
    if (selectedRunId) setActiveRunId(selectedRunId);
  }, [selectedRunId, selectedSessionId]);

  useEffect(() => {
    if (surface !== 'run' || !activeRunId) {
      setRunDetail(null);
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setDetailLoading(true);
    runsApi.getRun(activeRunId, { signal: controller.signal })
      .then(response => {
        if (active) setRunDetail(response?.run || null);
      })
      .catch(detailError => {
        if (active && detailError?.name !== 'AbortError') toast.error(detailError.message || '读取 Run 详情失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeRunId, detailReloadToken, surface]);

  const selectRun = useCallback((id) => {
    setSurface('run');
    setActiveRunId(id);
    navigateTo?.('runs', null, id);
  }, [navigateTo]);

  const openNewProviderSession = useCallback(() => {
    setSurface('new-session');
    setActiveRunId('');
    setRunDetail(null);
  }, []);

  const providerSessionRef = useMemo(() => runProviderSessionRef(runDetail), [runDetail]);
  const hasMore = page < totalPages;

  useEffect(() => {
    onPageContextChange?.({
      page_id: 'runs',
      project_id: surface === 'run' ? runDetail?.project_id || '' : '',
      run_id: surface === 'run' ? runDetail?.id || activeRunId || '' : '',
      session_id: surface === 'run' ? providerSessionRef : selectedSessionId,
      work_id: surface === 'run' ? runDetail?.work_id || '' : '',
      interaction_surface: surface !== 'run' ? 'provider-session' : '',
    });
  }, [activeRunId, onPageContextChange, providerSessionRef, runDetail, selectedSessionId, surface]);

  return (
    <section className="runs-page-shell bg-grid-tech">
      {surface === 'run' ? (
        <RunSidebar
          hasMore={hasMore}
          loading={loading}
          loadingMore={loadingMore}
          refreshing={refreshing}
          onLoadMore={loadMore}
          onNewProviderSession={() => {
            openNewProviderSession();
            onMobileSidebarAction?.();
          }}
          onRefresh={() => loadFirstPage()}
          onSelectRun={selectRun}
          runs={runs}
          selectedRunId={activeRunId}
        />
      ) : null}

      {surface === 'compat-session' ? (
        <div className="run-session-surface">
          <Sessions
            autoSelectFirstSession={false}
            keepNewSessionRoute
            navigateTo={navigateTo}
            selectedSessionId={selectedSessionId}
            showEvidence={false}
            showSidebar
          />
        </div>
      ) : surface === 'new-session' ? (
        <div className="run-session-surface">
          <NewProviderSessionNotice />
          <Sessions autoSelectFirstSession={false} keepNewSessionRoute navigateTo={navigateTo} showEvidence={false} showSidebar />
        </div>
      ) : error && runs.length === 0 ? (
        <RunLoadError error={error} onRetry={() => loadFirstPage()} />
      ) : detailLoading && !runDetail ? (
        <div className="run-detail-loading"><TurtleLoader label="正在重建 Run 视图…" /></div>
      ) : runDetail ? (
        <div className="run-detail-surface">
          <RunContextBar
            navigateTo={navigateTo}
            onRunChanged={(nextRun) => {
              setRunDetail(nextRun);
              setRuns(current => current.map(run => run.id === nextRun.id ? { ...run, ...nextRun } : run));
              loadFirstPage({ silent: true });
            }}
            run={runDetail}
          />
          <RunDetail navigateTo={navigateTo} run={runDetail} />
        </div>
      ) : (
        <div className="run-provider-empty">
          <History size={24} />
          <strong>{loading ? '正在读取 Runs…' : runs.length > 0 ? '选择左侧 Run 查看详情' : '暂无可显示的 Run'}</strong>
          <span>{runs.length > 0 ? '列表已就绪；详情只在选择后按需读取。' : 'Work 被 runner claim 后会生成统一 Run。'}</span>
        </div>
      )}
    </section>
  );
}

function NewProviderSessionNotice() {
  return (
    <div className="run-surface-notice">
      <strong>新建 provider session</strong>
      <span>独立对话保留旧能力；被 Work claim 的正式执行会出现在 Runs list。</span>
    </div>
  );
}

function RunLoadError({ error, onRetry }) {
  return (
    <div className="run-load-error" role="alert">
      <AlertTriangle size={20} />
      <strong>Runs 暂不可用</strong>
      <span>{error}</span>
      <button onClick={onRetry} type="button">重试</button>
    </div>
  );
}
