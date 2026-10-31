import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, History, LoaderCircle } from 'lucide-react';
import { eventsApi } from '../../api/events.js';
import { runsApi } from '../../api/runs.js';
import { RUN_REFRESH_EVENT_TYPES, mergeRunPages, providerLabel, runIssueId, runStatusLabel } from '../runs/runPageModel.js';

const RUN_PAGE_SIZE = 10;

// 任务详情的“执行” Tab：只列出这个任务的每次执行；完整过程到执行记录页查看。
export default function WorkRunList({ navigateTo, onLatestRunChange, onTotalChange, refreshToken = 0, selectedRunId = '', workId }) {
  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const listVersion = useRef(0);
  const issueId = runIssueId({ work_id: workId });

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

  useEffect(() => {
    setRuns([]);
    loadRuns();
  }, [loadRuns]);

  const lastRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (lastRefreshToken.current === refreshToken) return;
    lastRefreshToken.current = refreshToken;
    loadRuns({ silent: true });
  }, [loadRuns, refreshToken]);

  useEffect(() => { onLatestRunChange?.(runs[0] || null); }, [onLatestRunChange, runs]);
  useEffect(() => { onTotalChange?.(total); }, [onTotalChange, total]);

  // 与执行记录页同一组生命周期事件，只刷新本任务的执行列表。
  const refreshTimer = useRef(0);
  useEffect(() => {
    const unsubscribe = eventsApi.subscribeToEvents((event) => {
      if (!RUN_REFRESH_EVENT_TYPES.has(event?.type)) return;
      if (issueId && event?.issue_id && Number(event.issue_id) !== issueId) return;
      if (refreshTimer.current) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = 0;
        loadRuns({ silent: true });
      }, 250);
    });
    return () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = 0;
      unsubscribe();
    };
  }, [issueId, loadRuns]);

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
    return <div className="work-section-empty"><History size={16} /><span>还没有执行。任务开始后，每次执行会列在这里。</span></div>;
  }

  return (
    <div className="work-run-list">
      {listError ? <div className="work-resource-error" role="alert">{listError}</div> : null}
      <ul aria-label="执行列表">
        {runs.map((run, index) => {
          const error = run.status === 'failed' ? run.legacy?.error || '' : '';
          return (
            <li aria-current={run.id === selectedRunId || undefined} data-status={run.status || 'unknown'} key={run.id}>
              <i aria-hidden="true" />
              <div className="work-run-list-main">
                <strong>第 {run.sequence || total - index} 次执行</strong>
                <span>{runStatusLabel(run.status)} · {providerLabel(run.provider)} · {run.attempt_count || 1} 次尝试 · {formatTime(run.started_at || run.created_at)}{run.ended_at ? ` → ${formatTime(run.ended_at)}` : ''}</span>
                {error ? <p>{error}</p> : null}
              </div>
              <button onClick={() => navigateTo?.('runs', null, run.id)} type="button">查看执行记录 <ArrowUpRight size={13} /></button>
            </li>
          );
        })}
      </ul>
      {runs.length < total ? (
        <button className="work-run-list-more" disabled={loadingMore} onClick={loadMore} type="button">
          {loadingMore ? '加载中…' : `更早的 ${total - runs.length} 次`}
        </button>
      ) : null}
    </div>
  );
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
