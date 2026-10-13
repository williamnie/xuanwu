import { useCallback, useEffect, useRef, useState } from 'react';
import { History, LoaderCircle } from 'lucide-react';
import { eventsApi } from '../../api/events.js';
import { runsApi } from '../../api/runs.js';
import RunContextBar from '../runs/RunContextBar.jsx';
import RunDetail from '../runs/RunDetail.jsx';
import { RUN_REFRESH_EVENT_TYPES, mergeRunPages, runIssueId, runStatusLabel } from '../runs/runPageModel.js';
import '../runs/Runs.css';

const RUN_PAGE_SIZE = 10;
const ACTIVE_RUN_POLL_MS = 5_000;
const ACTIVE_RUN_STATUSES = new Set(['running', 'recovering']);

// 任务详情的“过程”：列出这个任务的每次执行，选中的执行直接复用执行记录页的完整视图。
export default function WorkRunProcess({ allowRunRetry = true, navigateTo, onLatestRunChange, onRunsChanged, refreshToken = 0, selectedRunId = '', workId }) {
  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [chosenRunId, setChosenRunId] = useState(selectedRunId);
  const [run, setRun] = useState(null);
  const [runError, setRunError] = useState('');
  const listVersion = useRef(0);
  const detailVersion = useRef(0);
  const activeRunId = chosenRunId || runs[0]?.id || '';
  const issueId = runIssueId({ work_id: workId });

  useEffect(() => { setChosenRunId(selectedRunId); }, [selectedRunId, workId]);

  const loadRuns = useCallback(async ({ silent = false } = {}) => {
    const version = ++listVersion.current;
    if (!silent) setListLoading(true);
    try {
      const response = await runsApi.getRuns({ page: 1, pageSize: RUN_PAGE_SIZE, workId });
      if (version !== listVersion.current) return;
      const items = response?.items || [];
      setRuns(current => silent ? mergeRunPages(items, current) : items);
      if (!silent) setPage(1);
      setTotal(Number(response?.total || items.length));
      setListError('');
    } catch (error) {
      if (version === listVersion.current) setListError(error.message || '读取执行列表失败');
    } finally {
      if (version === listVersion.current) setListLoading(false);
    }
  }, [workId]);

  const loadRun = useCallback(async (runId, { silent = false } = {}) => {
    if (!runId) return;
    const version = ++detailVersion.current;
    if (!silent) setRun(null);
    try {
      const response = await runsApi.getRun(runId);
      if (version !== detailVersion.current) return;
      const nextRun = response?.run || null;
      if (nextRun && nextRun.work_id && nextRun.work_id !== workId) {
        setRunError('这次执行不属于当前任务，请到执行记录中查看。');
        setRun(null);
        return;
      }
      setRun(nextRun);
      setRunError('');
    } catch (error) {
      if (version === detailVersion.current) setRunError(error.message || '读取执行详情失败');
    }
  }, [workId]);

  useEffect(() => {
    setRuns([]);
    setRun(null);
    setRunError('');
    loadRuns();
  }, [loadRuns]);

  useEffect(() => { loadRun(activeRunId); }, [activeRunId, loadRun]);

  const lastRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (lastRefreshToken.current === refreshToken) return;
    lastRefreshToken.current = refreshToken;
    loadRuns({ silent: true });
    loadRun(activeRunId, { silent: true });
  }, [activeRunId, loadRun, loadRuns, refreshToken]);

  useEffect(() => { onLatestRunChange?.(runs[0] || null); }, [onLatestRunChange, runs]);

  // 与执行记录页同一组生命周期事件；只刷新本任务的列表和当前选中的执行。
  const refreshTimer = useRef(0);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = 0;
      loadRuns({ silent: true });
      loadRun(activeRunId, { silent: true });
    }, 250);
  }, [activeRunId, loadRun, loadRuns]);

  useEffect(() => {
    const unsubscribe = eventsApi.subscribeToEvents((event) => {
      if (!RUN_REFRESH_EVENT_TYPES.has(event?.type)) return;
      if (issueId && event?.issue_id && Number(event.issue_id) !== issueId) return;
      scheduleRefresh();
    });
    return () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = 0;
      unsubscribe();
    };
  }, [issueId, scheduleRefresh]);

  const runActive = ACTIVE_RUN_STATUSES.has(run?.status);
  useEffect(() => {
    if (!runActive) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadRun(activeRunId, { silent: true });
    }, ACTIVE_RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeRunId, loadRun, runActive]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await runsApi.getRuns({ page: page + 1, pageSize: RUN_PAGE_SIZE, workId });
      setRuns(current => mergeRunPages(current, response?.items || []));
      setPage(page + 1);
      setTotal(Number(response?.total || total));
    } catch (error) {
      setListError(error.message || '读取更早的执行失败');
    } finally {
      setLoadingMore(false);
    }
  };

  if (listLoading && runs.length === 0) {
    return <div className="work-section-empty"><LoaderCircle className="is-spinning" size={16} /><span>正在读取执行…</span></div>;
  }
  if (listError && runs.length === 0) {
    return <div className="work-resource-error" role="alert">{listError}<button onClick={() => loadRuns()} type="button">重试</button></div>;
  }
  if (runs.length === 0) {
    return <div className="work-section-empty"><History size={16} /><span>还没有执行。任务开始后，每次执行的过程会显示在这里。</span></div>;
  }

  return (
    <div className="work-run-process">
      <div aria-label="执行列表" className="run-attempt-tabs work-run-tabs" role="tablist">
        <span className="run-attempt-tabs-label">Runs</span>
        {runs.map((item, index) => (
          <button
            aria-selected={item.id === activeRunId}
            data-status={item.status || 'unknown'}
            key={item.id}
            onClick={() => setChosenRunId(item.id)}
            role="tab"
            type="button"
          >
            <i />
            <span>第 {item.sequence || total - index} 次执行</span>
            <small>{runStatusLabel(item.status)} · {formatTime(item.started_at || item.created_at)}</small>
          </button>
        ))}
        {runs.length < total ? (
          <button className="work-run-tabs-more" disabled={loadingMore} onClick={loadMore} type="button">
            {loadingMore ? '加载中…' : `更早的 ${total - runs.length} 次`}
          </button>
        ) : null}
      </div>
      {runError ? <div className="work-resource-error" role="alert">{runError}</div> : null}
      {run ? (
        <div className="work-run-embed">
          <RunContextBar
            allowRetry={allowRunRetry}
            navigateTo={navigateTo}
            onRunChanged={(nextRun) => {
              setRun(nextRun);
              loadRuns({ silent: true });
              onRunsChanged?.();
            }}
            run={run}
            showWorkLink={false}
          />
          <RunDetail navigateTo={navigateTo} run={run} />
        </div>
      ) : !runError ? (
        <div className="work-section-empty"><LoaderCircle className="is-spinning" size={16} /><span>正在读取这次执行…</span></div>
      ) : null}
    </div>
  );
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
