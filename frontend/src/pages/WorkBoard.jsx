import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BriefcaseBusiness,
  Columns3,
  List,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { workApi } from '../api/work.js';
import { eventsApi } from '../api/events.js';
import EvidencePanel from '../components/EvidencePanel.jsx';
import ModalOverlay from '../components/ModalOverlay.jsx';
import { selectProjects, selectWorkSummary, useDataStore } from '../store/dataStore';
import { message } from '../store/toastStore.js';
import WorkDetail from './WorkDetail.jsx';
import TaskList from './work/TaskList.jsx';
import TaskSubviewTabs from './work/TaskSubviewTabs.jsx';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import { executeWorkMove } from './work/workActions.js';
import {
  filterWorkBoardItems,
  groupWorksByStatus,
  issueIdFromWorkId,
  laneScrollDecision,
  WORK_BOARD_STATUSES,
  workDropOperation,
  workNeedsAttention,
} from './workBoardModel.js';
import './WorkBoard.css';
import { useI18n } from '../i18n/context.js';

const STATUS_META = {
  triage: { label: 'Triage', tone: 'amber' },
  todo: { label: 'Todo', tone: 'slate' },
  in_progress: { label: 'In progress', tone: 'blue' },
  needs_user: { label: 'Needs user', tone: 'violet' },
  failed: { label: 'Failed', tone: 'red' },
  done: { label: 'Done', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

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

const TASK_VIEW_STORAGE_KEY = 'xuanwu-task-view';

// 任务页：默认列表视图，看板保留为可切换视图；两者共享搜索、项目筛选和同一套创建/编辑对话框。
export default function WorkBoard({ navigateTo, onPageContextChange, selectedHandoffId = '', selectedRunId = '', selectedWorkId = '' }) {
  const projects = useDataStore(selectProjects);
  const workSummary = useDataStore(selectWorkSummary);
  const [view, setView] = useState(readTaskView);
  const [scope, setScope] = useState('active');
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  const [dialog, setDialog] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken(value => value + 1), []);

  useEffect(() => {
    if (selectedWorkId) return;
    onPageContextChange?.({ page_id: 'work', project_id: projectId });
  }, [onPageContextChange, projectId, selectedWorkId]);

  const changeView = (next) => {
    setView(next);
    try { localStorage.setItem(TASK_VIEW_STORAGE_KEY, next); } catch { /* 仅为个人偏好，存储不可用时忽略。 */ }
  };

  if (selectedWorkId) {
    return (
      <WorkDetail
        navigateTo={navigateTo}
        onPageContextChange={onPageContextChange}
        onWorkChanged={refresh}
        projects={projects}
        selectedHandoffId={selectedHandoffId}
        selectedRunId={selectedRunId}
        workId={selectedWorkId}
      />
    );
  }

  const counts = projectId
    ? workSummary.project_counts?.find(item => item.project_id === projectId)?.counts || {}
    : workSummary.counts || {};

  return (
    <section className={`work-board-page is-${view}`}>
      <TaskSubviewTabs active="work" navigateTo={navigateTo} />
      <WorkBoardHeader
        onCreate={() => setDialog({ mode: 'create' })}
        onProjectChange={setProjectId}
        onQueryChange={setQuery}
        onRefresh={refresh}
        onViewChange={changeView}
        projectId={projectId}
        projects={projects}
        query={query}
        view={view}
      />
      {view === 'list' ? (
        <div className="work-list-scroll">
          <TaskList
            counts={counts}
            navigateTo={navigateTo}
            onCreate={() => setDialog({ mode: 'create' })}
            onEdit={work => setDialog({ mode: 'edit', work })}
            onScopeChange={setScope}
            projectId={projectId}
            projects={projects}
            query={query}
            refreshToken={refreshToken}
            scope={scope}
          />
        </div>
      ) : (
        <WorkKanban
          navigateTo={navigateTo}
          onEdit={work => setDialog({ mode: 'edit', work })}
          projectId={projectId}
          query={query}
          refreshToken={refreshToken}
        />
      )}
      {dialog ? (
        <WorkEditorDialog
          initialProject={dialog.mode === 'create' ? projectId : undefined}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
          projects={projects}
          work={dialog.work}
        />
      ) : null}
    </section>
  );
}

function readTaskView() {
  try {
    return localStorage.getItem(TASK_VIEW_STORAGE_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

function WorkKanban({ navigateTo, onEdit, projectId, query, refreshToken }) {
  const { t } = useI18n();
  const projects = useDataStore(selectProjects);
  const workSummary = useDataStore(selectWorkSummary);
  const selectedWorkId = '';
  const [works, setWorks] = useState([]);
  const filters = useMemo(() => ({ ...EMPTY_FILTERS, project: projectId, query }), [projectId, query]);
  const [evidenceWork, setEvidenceWork] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMoreStatus, setLoadingMoreStatus] = useState('');
  const [error, setError] = useState('');
  const [lanePages, setLanePages] = useState({});
  const [draggingWork, setDraggingWork] = useState(null);
  const [draggedOverStatus, setDraggedOverStatus] = useState('');
  const [movingWorkId, setMovingWorkId] = useState('');
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
    const pending = workApi.getWorkBoard({ statuses: OPERATIONAL_STATUSES }, { signal: controller.signal });
    boardRequest.current = pending;
    try {
      const boardResponse = await pending;
      const snapshot = normalizeBoardSnapshot(boardResponse, workSummaryRef.current);
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
  }, [selectedWorkId, t]);

  useEffect(() => {
    workSummaryRef.current = workSummary;
    setLanePages(current => ({
      ...current,
      ...Object.fromEntries(HISTORY_STATUSES.map(status => [status, {
        ...normalizeLanePage({ total: workSummary.counts?.[status] || 0 }, 20, 'not_loaded'),
        ...current[status],
        total: workSummary.counts?.[status] || 0,
      }]))
    }));
  }, [workSummary]);

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
      }, { signal: controller.signal });
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
  }, [lanePages, loading, selectedWorkId, t]);

  const loadHistory = useCallback(async (status) => {
    if (!HISTORY_STATUSES.includes(status) || ['loading', 'loaded'].includes(lanePages[status]?.loadState)) return;
    setLanePages(current => ({
      ...current,
      [status]: { ...current[status], loadState: 'loading' },
    }));
    try {
      const response = await workApi.getWorks({ pageSize: 20, statuses: [status] });
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
  }, [lanePages, t]);

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

  const handleDragStart = (event, work) => {
    if (event.target instanceof Element && event.target.closest('button')) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData('text/plain', JSON.stringify({ workId: work.id }));
    event.dataTransfer.effectAllowed = 'move';
    setTimeout(() => setDraggingWork({ id: work.id, status: work.status }), 0);
  };

  const resetDragState = () => {
    setDraggingWork(null);
    setDraggedOverStatus('');
  };

  const handleDragOver = (event, status) => {
    if (movingWorkId || !draggingWork || draggingWork.status === status) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = workDropOperation(draggingWork.status, status) === 'blocked' ? 'none' : 'move';
    if (draggedOverStatus !== status) setDraggedOverStatus(status);
  };

  const handleDragLeave = (event, status) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (draggedOverStatus === status) setDraggedOverStatus('');
  };

  const handleDrop = async (event, targetStatus) => {
    event.preventDefault();
    const payload = dragPayload(event.dataTransfer.getData('text/plain'));
    const work = works.find(item => item.id === payload?.workId);
    resetDragState();
    if (!work || work.status === targetStatus || movingWorkId) return;

    const operation = workDropOperation(work.status, targetStatus);
    if (operation === 'blocked') {
      message.warning(t('board.dropBlocked'));
      return;
    }

    setMovingWorkId(work.id);
    try {
      const result = await executeWorkMove(work, targetStatus);
      const actualStatus = result?.status || targetStatus;
      const targetLabel = t(`status.${targetStatus}`);
      const actualLabel = t(`status.${actualStatus}`);
      if (result.operation === 'enqueue') {
        message.success(t('board.enqueued', { issue: issueIdFromWorkId(work.id) }));
      } else if (result.operation === 'retry') {
        message.success(t('board.requeued', { issue: issueIdFromWorkId(work.id) }));
      } else if (actualStatus === targetStatus) {
        message.success(t('board.moved', { issue: issueIdFromWorkId(work.id), status: targetLabel }));
      } else {
        message.success(t('board.gated', { status: actualLabel }));
      }
      refresh();
    } catch (moveError) {
      message.error(t('board.moveFailed', { error: moveError.message || t('board.networkError') }));
    } finally {
      setMovingWorkId('');
    }
  };

  return (
    <>
      {error ? (
        <div className="work-board-error" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>{t('board.unavailable')}</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={refresh}>{t('chat.retry')}</button>
        </div>
      ) : (
        <div className="work-board-scroll" aria-busy={loading}>
          <div
            className="work-board-columns"
            style={{ minWidth: `${WORK_BOARD_STATUSES.length * 276}px` }}
          >
            {WORK_BOARD_STATUSES.map(status => {
              const lane = lanePages[status];
              return (
                <WorkColumn
                  key={status}
                  dropState={workColumnDropState(draggingWork, draggedOverStatus, status)}
                  draggingWorkId={draggingWork?.id || ''}
                  hasMore={Boolean(lane?.hasMore)}
                  loadingMore={loadingMoreStatus === status}
                  loadState={lane?.loadState || 'loaded'}
                  navigateTo={navigateTo}
                  onEdit={onEdit}
                  onEvidence={setEvidenceWork}
                  onLoadMore={loadMore}
                  onVisible={loadHistory}
                  onReachEnd={handleColumnScroll}
                  onDragEnd={resetDragState}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDragStart={handleDragStart}
                  onDrop={handleDrop}
                  projectNames={projectNames}
                  status={status}
                  total={lane?.total || 0}
                  movingWorkId={movingWorkId}
                  works={groupedWorks.get(status) || []}
                />
              );
            })}
          </div>
          {loading ? <div className="work-board-loading">{t('board.loading')}</div> : null}
        </div>
      )}

      {evidenceWork ? (
        <WorkEvidenceDialog onClose={() => setEvidenceWork(null)} work={evidenceWork} />
      ) : null}
    </>
  );
}

function WorkBoardHeader({ onCreate, onProjectChange, onQueryChange, onRefresh, onViewChange, projectId, projects, query, view }) {
  const { t } = useI18n();
  return (
    <header className="work-ledger-header">
      <div className="work-ledger-title">
        <div className="work-ledger-kicker"><BriefcaseBusiness size={14} /> {t('board.ledger')}</div>
        <div className="work-ledger-heading-row">
          <h1>{t('work.board')}</h1>
        </div>
      </div>
      <div className="work-ledger-actions">
        <label className="work-header-search">
          <Search size={15} />
          <input
            aria-label={t('board.search')}
            onChange={event => onQueryChange(event.target.value)}
            placeholder={t('board.searchPlaceholder')}
            type="search"
            value={query}
          />
        </label>
        {projects.length > 1 ? (
          <select aria-label="按项目筛选" className="form-control work-header-project" onChange={event => onProjectChange(event.target.value)} value={projectId}>
            <option value="">全部项目</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}
          </select>
        ) : null}
        <div className="work-view-toggle" role="group" aria-label="视图">
          <button aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => onViewChange('list')} title="列表" type="button"><List size={14} /></button>
          <button aria-label="看板视图" aria-pressed={view === 'board'} onClick={() => onViewChange('board')} title="看板" type="button"><Columns3 size={14} /></button>
        </div>
        <button aria-label={t('work.refresh')} className="work-action-secondary work-action-icon" onClick={onRefresh} title={t('work.refresh')} type="button">
          <RefreshCw size={14} />
        </button>
        <button className="work-action-primary" onClick={onCreate} type="button">
          <Plus size={16} /> {t('board.newWork')}
        </button>
      </div>
    </header>
  );
}

function WorkColumn({
  dropState,
  draggingWorkId,
  hasMore,
  loadingMore,
  loadState,
  movingWorkId,
  navigateTo,
  onDragEnd,
  onDragLeave,
  onDragOver,
  onDragStart,
  onDrop,
  onEdit,
  onEvidence,
  onLoadMore,
  onVisible,
  onReachEnd,
  projectNames,
  status,
  total,
  works,
}) {
  const { t } = useI18n();
  const meta = STATUS_META[status] || { label: status, tone: 'slate' };
  const columnRef = useRef(null);
  useEffect(() => {
    if (!HISTORY_STATUSES.includes(status) || !columnRef.current || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onVisible(status);
    }, { rootMargin: '120px' });
    observer.observe(columnRef.current);
    return () => observer.disconnect();
  }, [onVisible, status]);
  return (
    <section
      ref={columnRef}
      className={`work-column ${dropState ? `is-drag-over is-drop-${dropState}` : ''}`.trim()}
      data-tone={meta.tone}
      onDragLeave={event => onDragLeave(event, status)}
      onDragOver={event => onDragOver(event, status)}
      onDrop={event => onDrop(event, status)}
    >
      <header className="work-column-header">
        <span className="work-column-marker" />
        <h2>{t(`status.${status}`)}</h2>
        <span>{total}</span>
      </header>
      <div className="work-column-stack" onScroll={event => onReachEnd(event, status)}>
        {works.length > 0 ? works.map(work => (
          <WorkCard
            key={work.id}
            navigateTo={navigateTo}
            dragging={draggingWorkId === work.id}
            moving={movingWorkId === work.id}
            onEdit={onEdit}
            onEvidence={onEvidence}
            onDragEnd={onDragEnd}
            onDragStart={onDragStart}
            projectName={projectNames.get(work.owner?.project_id) || work.owner?.project_id || 'Unscoped'}
            work={work}
          />
        )) : <WorkColumnEmpty loadState={loadState} onRetry={() => onVisible(status)} />}
        {hasMore ? (
          <button
            className="work-column-load-more"
            disabled={loadingMore}
            onClick={() => onLoadMore(status)}
            type="button"
          >
            {loadingMore ? t('board.loadingMore') : t('board.loadMoreStatus', { status: t(`status.${status}`) })}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function WorkColumnEmpty({ loadState, onRetry }) {
  if (loadState === 'not_loaded') {
    return <div className="work-column-empty">滚动到此列后加载历史任务</div>;
  }
  if (loadState === 'loading') {
    return <div className="work-column-empty">正在加载历史任务…</div>;
  }
  if (loadState === 'error') {
    return (
      <button className="work-column-load-more" onClick={onRetry} type="button">
        历史任务加载失败，重试
      </button>
    );
  }
  return <div className="work-column-empty">此列暂无任务</div>;
}

function mergeWorks(current, incoming) {
  const merged = new Map(current.map(work => [work.id, work]));
  incoming.forEach(work => merged.set(work.id, work));
  return [...merged.values()];
}

function mergeOperationalSnapshot(current, refreshed) {
  const refreshedIds = new Set(refreshed.map(work => work.id));
  return [
    ...refreshed,
    ...current.filter(work => HISTORY_STATUSES.includes(work.status) && !refreshedIds.has(work.id)),
  ];
}

function mergeRefreshedLanePages(current, refreshed) {
  return Object.fromEntries(WORK_BOARD_STATUSES.map(status => [
    status,
    HISTORY_STATUSES.includes(status) ? current[status] || refreshed[status] : {
      ...refreshed[status],
      page: Math.max(Number(current[status]?.page || 1), Number(refreshed[status]?.page || 1)),
    },
  ]));
}

function normalizeBoardSnapshot(response, summary) {
  const lanePages = {};
  const items = [];
  let total = 0;
  WORK_BOARD_STATUSES.forEach((status) => {
    const lane = response?.lanes?.[status] || {};
    const history = HISTORY_STATUSES.includes(status);
    lanePages[status] = history
      ? normalizeLanePage({ total: summary?.counts?.[status] || 0 }, response?.page_size || 20, 'not_loaded')
      : normalizeLanePage(lane, response?.page_size || 20, 'loaded');
    items.push(...(lane?.items || []));
    total += lanePages[status].total;
  });
  return { items: mergeWorks([], items), lanePages, total };
}

function normalizeLanePage(response, fallbackPageSize, loadState = 'loaded') {
  return {
    hasMore: Boolean(response?.has_more ?? (Number(response?.page || 1) < Number(response?.total_pages || 0))),
    loadState,
    nextCursor: String(response?.next_cursor || ''),
    page: Number(response?.page || 1),
    pageSize: Number(response?.page_size || fallbackPageSize || 20),
    total: Number(response?.total || 0),
    totalPages: Number(response?.total_pages || 0),
  };
}

function WorkCard({ dragging, moving, navigateTo, onDragEnd, onDragStart, onEdit, onEvidence, projectName, work }) {
  const { t } = useI18n();
  const issueId = issueIdFromWorkId(work.id);
  const needsAttention = workNeedsAttention(work);
  return (
    <article
      aria-busy={moving}
      aria-grabbed={dragging}
      className={`work-card ${dragging ? 'is-dragging' : ''} ${moving ? 'is-moving' : ''}`.trim()}
      draggable={!moving}
      onDragEnd={onDragEnd}
      onDragStart={event => onDragStart(event, work)}
    >
      <div className="work-card-topline">
        <div className="work-card-identity">
          <span className="work-type-badge">{t(`workType.${work.type}`)}</span>
          <span className="work-issue-label">{issueId ? `Issue #${issueId}` : work.id}</span>
        </div>
        {needsAttention ? <span className="work-attention-badge"><AlertTriangle size={12} /> {t('timeline.approval')}</span> : null}
      </div>
      <h3>{work.title}</h3>
      <p>{work.goal}</p>
      <div className="work-card-project">{projectName}</div>
      <div className="work-card-footer">
        <button className="work-detail-link" onClick={() => navigateTo('work', work.id)} type="button">
          {t('board.open')} <ArrowUpRight size={13} />
        </button>
        <button onClick={() => onEdit(work)} type="button"><Pencil size={13} /> {t('work.edit')}</button>
        <button className="work-evidence-link" onClick={() => onEvidence(work)} type="button">
          <ShieldCheck size={13} /> {t('timeline.evidence')}
        </button>
      </div>
    </article>
  );
}

function WorkEvidenceDialog({ onClose, work }) {
  const { t } = useI18n();
  return (
    <ModalOverlay className="work-evidence-overlay" onBackdropMouseDown={onClose}>
      <div aria-labelledby="work-evidence-title" aria-modal="true" className="work-evidence-dialog" role="dialog">
        <header>
          <div>
            <span>{t('board.decisiveFacts')}</span>
            <h2 id="work-evidence-title">{work.title}</h2>
            <p>{t('board.evidenceDescription')}</p>
          </div>
          <button aria-label={t('board.closeEvidence')} onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <EvidencePanel title="Work Evidence" workId={work.id} />
      </div>
    </ModalOverlay>
  );
}

function dragPayload(value) {
  try {
    const payload = JSON.parse(value);
    return typeof payload?.workId === 'string' ? payload : null;
  } catch {
    return null;
  }
}

function workColumnDropState(draggingWork, draggedOverStatus, status) {
  if (!draggingWork || draggedOverStatus !== status) return '';
  return workDropOperation(draggingWork.status, status) === 'blocked' ? 'blocked' : 'allowed';
}
