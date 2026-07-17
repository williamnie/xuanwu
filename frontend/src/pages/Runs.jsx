import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CircleStop,
  History,
  Play,
  RotateCcw,
} from 'lucide-react';
import { eventsApi } from '../api/events.js';
import { runsApi } from '../api/runs.js';
import TurtleLoader from '../components/TurtleLoader';
import { message as toast } from '../store/toastStore';
import Sessions from './Sessions.jsx';
import RunDetail from './runs/RunDetail.jsx';
import RunSidebar from './runs/RunSidebar.jsx';
import {
  buildRunControlPayload,
  mergeRunPages,
  runAvailableActions,
  runIssueId,
  runProviderSessionRef,
  runStatusLabel,
} from './runs/runPageModel.js';
import './runs/Runs.css';

const RUN_PAGE_SIZE = 50;
const RUN_RECONCILE_INTERVAL_MS = 30_000;
const RUN_REFRESH_EVENT_TYPES = new Set([
  'issue.runtime_updated',
  'issue.status_changed',
  'run.lifecycle.intent.v1',
  'run.lifecycle.outcome.v1',
  'run.lifecycle.run_materialized.v1',
]);

export default function Runs({ navigateTo, onPageContextChange, selectedRunId = '', selectedSessionId = '' }) {
  const [runs, setRuns] = useState([]);
  const [compatibility, setCompatibility] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [surface, setSurface] = useState(selectedSessionId ? 'compat-session' : 'run');
  const [activeRunId, setActiveRunId] = useState(selectedRunId);
  const [runDetail, setRunDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadFirstPage = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await runsApi.getRuns({ page: 1, pageSize: RUN_PAGE_SIZE });
      setRuns(response?.items || []);
      setCompatibility(response?.compatibility || null);
      setPage(Number(response?.page || 1));
      setTotalPages(Number(response?.total_pages || 0));
      setError('');
    } catch (loadError) {
      setError(loadError.message || '加载 Runs 失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || page >= totalPages) return;
    setLoadingMore(true);
    try {
      const response = await runsApi.getRuns({ page: page + 1, pageSize: RUN_PAGE_SIZE });
      setRuns(current => mergeRunPages(current, response?.items || []));
      setPage(Number(response?.page || page + 1));
      setTotalPages(Number(response?.total_pages || totalPages));
    } catch (loadError) {
      toast.error(loadError.message || '继续加载 Runs 失败');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, page, totalPages]);

  useEffect(() => { loadFirstPage(); }, [loadFirstPage]);

  useEffect(() => {
    const interval = window.setInterval(() => loadFirstPage({ silent: true }), RUN_RECONCILE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadFirstPage]);

  useEffect(() => eventsApi.subscribeToEvents((event) => {
    if (RUN_REFRESH_EVENT_TYPES.has(event.type)) loadFirstPage({ silent: true });
  }), [loadFirstPage]);

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
    if (surface === 'run' && !activeRunId && runs[0]?.id) setActiveRunId(runs[0].id);
  }, [activeRunId, runs, surface]);

  useEffect(() => {
    if (surface !== 'run' || !activeRunId) {
      setRunDetail(null);
      return undefined;
    }
    let active = true;
    setDetailLoading(true);
    runsApi.getRun(activeRunId)
      .then(response => {
        if (active) setRunDetail(response?.run || null);
      })
      .catch(detailError => {
        if (active) toast.error(detailError.message || '读取 Run 详情失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [activeRunId, surface]);

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
    });
  }, [activeRunId, onPageContextChange, providerSessionRef, runDetail, selectedSessionId, surface]);

  return (
    <section className="runs-page-shell">
      <RunSidebar
        compatibility={compatibility}
        hasMore={hasMore}
        loading={loading}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
        onNewProviderSession={openNewProviderSession}
        onRefresh={() => loadFirstPage()}
        onSelectRun={selectRun}
        runs={runs}
        selectedRunId={surface === 'run' ? activeRunId : ''}
      />

      {surface === 'compat-session' ? (
        <div className="run-session-surface">
          <CompatibilitySessionNotice />
          <Sessions
            autoSelectFirstSession={false}
            navigateTo={navigateTo}
            selectedSessionId={selectedSessionId}
            showSidebar={false}
          />
        </div>
      ) : surface === 'new-session' ? (
        <div className="run-session-surface">
          <NewProviderSessionNotice />
          <Sessions autoSelectFirstSession={false} navigateTo={navigateTo} showSidebar={false} />
        </div>
      ) : error && runs.length === 0 ? (
        <RunLoadError error={error} onRetry={() => loadFirstPage()} />
      ) : detailLoading && !runDetail ? (
        <div className="run-detail-loading"><TurtleLoader label="正在重建 Run 视图…" /></div>
      ) : runDetail ? (
        <div className="run-detail-surface">
          <RunContextBar
            compatibility={compatibility}
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
          <strong>{loading ? '正在读取 Runs…' : '暂无可显示的 Run'}</strong>
          <span>Work 被 runner claim 后会生成统一 Run。</span>
        </div>
      )}
    </section>
  );
}

function RunContextBar({ compatibility, navigateTo, onRunChanged, run }) {
  const [pendingAction, setPendingAction] = useState('');
  const [resumePrompt, setResumePrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const actions = runAvailableActions(run);
  const issueId = runIssueId(run);

  const controlRun = async (action) => {
    if (submitting || (action === 'resume' && !resumePrompt.trim())) return;
    setSubmitting(true);
    try {
      const eventId = `runs-ui:${action}:${randomEventId()}`;
      const response = await runsApi.controlRun(run.id, action, buildRunControlPayload(run, action, {
        eventId,
        prompt: resumePrompt,
      }));
      onRunChanged(response.run);
      setPendingAction('');
      setResumePrompt('');
      toast.success(action === 'interrupt' ? 'Run 中断已审计提交' : action === 'resume' ? 'Run 已恢复' : 'Run 重试已请求');
    } catch (controlError) {
      toast.error(controlError.message || `Run ${action} 失败`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="run-context-bar">
      <div className="run-context-main">
        <div className="run-context-title-row">
          <span className={`run-context-status ${run.status || 'unknown'}`}>{runStatusLabel(run.status)}</span>
          <strong>{run.work_title || 'Untitled Work'}</strong>
          {issueId ? (
            <button className="run-work-link" onClick={() => navigateTo?.('issues', issueId)} type="button">
              Work #{issueId} <ArrowUpRight size={12} />
            </button>
          ) : null}
        </div>
        <div className="run-context-meta">
          <span>{run.provider || 'unknown'} provider</span>
          <span>Run {run.sequence || '?'}</span>
          <span>Attempt {run.progress?.attempt_sequence || run.attempt_count || '?'}</span>
          <span>Phase {run.progress?.provider_phase || run.progress?.phase || 'unknown'}</span>
          {run.progress?.stalled?.detected ? <span className="run-context-warning">Stalled</span> : null}
        </div>
      </div>

      <div className="run-context-actions">
        {actions.interrupt ? (
          <button onClick={() => setPendingAction('interrupt')} type="button"><CircleStop size={13} /> 中断</button>
        ) : null}
        {actions.resume ? (
          <button onClick={() => setPendingAction('resume')} type="button"><Play size={13} /> 继续</button>
        ) : null}
        {actions.retry ? (
          <button onClick={() => setPendingAction('retry')} type="button"><RotateCcw size={13} /> 重试</button>
        ) : null}
      </div>

      {pendingAction ? (
        <div className="run-control-confirm" role="group" aria-label={`确认 ${pendingAction}`}>
          {pendingAction === 'resume' ? (
            <textarea
              autoFocus
              onChange={event => setResumePrompt(event.target.value)}
              placeholder="输入继续本 Run 的指令"
              rows={2}
              value={resumePrompt}
            />
          ) : (
            <span>确认{pendingAction === 'interrupt' ? '中断当前 Attempt' : '请求新的 Run'}？操作会写入 lifecycle audit。</span>
          )}
          <div>
            <button disabled={submitting} onClick={() => setPendingAction('')} type="button">取消</button>
            <button
              className="run-control-primary"
              disabled={submitting || (pendingAction === 'resume' && !resumePrompt.trim())}
              onClick={() => controlRun(pendingAction)}
              type="button"
            >
              {submitting ? '提交中…' : '确认提交'}
            </button>
          </div>
        </div>
      ) : null}

      <details className="run-compatibility-details">
        <summary>兼容与迁移</summary>
        <span>Run source of truth: {compatibility?.read_authority || 'issue_runs'}；provider session 仅 observation。</span>
        <span>双写：{compatibility?.dual_write || 'none'}；双读：{compatibility?.dual_read || 'W2 at most one release'}。</span>
        <span>回滚：注销 Runs route 并恢复 legacy Issue/Session control，不删除 authority data。</span>
        <span>最终删除门禁：{compatibility?.final_removal_gate || 'P11.05 + G7 + zero Sessions consumer + backup/restore window'}。</span>
      </details>
    </div>
  );
}

function CompatibilitySessionNotice() {
  return (
    <div className="run-surface-notice compat">
      <strong>Sessions 兼容 deep link</strong>
      <span>此入口在迁移窗口内保留旧 provider session 操作；返回 Runs 后以 Work/Run 为执行主线。</span>
    </div>
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

function randomEventId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
