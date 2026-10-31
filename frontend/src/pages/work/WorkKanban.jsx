import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { message } from '../../store/toastStore.js';
import { executeWorkMove } from '../work/workActions.js';
import { issueIdFromWorkId, WORK_BOARD_STATUSES, workDropOperation } from '../workBoardModel.js';
import { useI18n } from '../../i18n/context.js';
import useWorkKanbanData from './useWorkKanbanData.js';
import WorkColumn from './WorkColumn.jsx';
import WorkEvidenceDialog from './WorkEvidenceDialog.jsx';

export default function WorkKanban({ navigateTo, onEdit, projectId, query, refreshToken, source }) {
  const { t } = useI18n();
  const { works, error, loading, lanePages, loadingMoreStatus, loadMore, loadHistory, handleColumnScroll, projectNames, groupedWorks, refresh } = useWorkKanbanData({ projectId, query, refreshToken, source });
  const [evidenceWork, setEvidenceWork] = useState(null);
  const [draggingWork, setDraggingWork] = useState(null);
  const [draggedOverStatus, setDraggedOverStatus] = useState('');
  const [movingWorkId, setMovingWorkId] = useState('');
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
          <AlertTriangle size={16} />
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
                  total={lane?.total ?? ''}
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
