import RemoteProjectBadge from '../../components/RemoteProjectBadge.jsx';
import { useProjectNodes } from '../../store/useProjectNodes.js';
import WorkSchedule from '../work/WorkSchedule.jsx';
import { useEffect, useRef } from 'react';
import { AlertTriangle, ArrowUpRight, Pencil, ShieldCheck } from 'lucide-react';
import { useDataStore } from '../../store/dataStore';
import { issueIdFromWorkId, workNeedsAttention } from '../workBoardModel.js';
import { useI18n } from '../../i18n/context.js';

const STATUS_META = {
  triage: { label: 'Triage', tone: 'amber' },
  todo: { label: 'Todo', tone: 'slate' },
  in_progress: { label: 'In progress', tone: 'blue' },
  needs_user: { label: 'Needs user', tone: 'violet' },
  failed: { label: 'Failed', tone: 'red' },
  done: { label: 'Done', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};
const HISTORY_STATUSES = ['done', 'cancelled'];
export default function WorkColumn({
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
function WorkCard({ dragging, moving, navigateTo, onDragEnd, onDragStart, onEdit, onEvidence, projectName, work }) {
  const { t } = useI18n();
  const issueId = issueIdFromWorkId(work.id);
  const needsAttention = workNeedsAttention(work);
  const project = useDataStore(state => state.projects.find(item => item.id === work.owner?.project_id));
  const nodesById = useProjectNodes();
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
        {needsAttention ? <span className="work-attention-badge"><AlertTriangle size={13} /> {t('timeline.approval')}</span> : null}
      </div>
      <h3>{work.title}</h3>
      <p>{work.goal}</p>
      <WorkSchedule work={work} />
      <div className="work-card-project"><RemoteProjectBadge project={project} nodesById={nodesById} /> {projectName}</div>
      <div className="work-card-footer">
        <button className="work-detail-link" onClick={() => navigateTo('tasks', work.id)} type="button">
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
