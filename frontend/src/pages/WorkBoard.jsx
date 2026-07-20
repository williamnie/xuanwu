import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BriefcaseBusiness,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { workApi } from '../api/work.js';
import EvidencePanel from '../components/EvidencePanel.jsx';
import { selectProjects, useDataStore } from '../store/dataStore';
import { message } from '../store/toastStore.js';
import WorkDetail from './WorkDetail.jsx';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import {
  filterWorkBoardItems,
  groupWorksByStatus,
  indexRelationsByWork,
  issueIdFromWorkId,
  WORK_BOARD_STATUSES,
  workDropOperation,
  workNeedsAttention,
} from './workBoardModel.js';
import './WorkBoard.css';

const STATUS_META = {
  triage: { label: 'Triage', tone: 'amber' },
  todo: { label: 'Todo', tone: 'slate' },
  in_progress: { label: 'In progress', tone: 'blue' },
  pending_verification: { label: 'Verification', tone: 'violet' },
  failed: { label: 'Failed', tone: 'red' },
  done: { label: 'Done', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

const TYPE_LABELS = {
  engineering_task: 'Engineering task',
  objective: 'Objective',
};

const RELATION_LABELS = {
  authorization: 'Delegation',
  execution: 'Action',
  observation: 'Watch',
};

const EMPTY_FILTERS = {
  attention: '',
  delivery: '',
  project: '',
  query: '',
  status: '',
  type: '',
};

export default function WorkBoard({ navigateTo, onPageContextChange, selectedWorkId = '' }) {
  const projects = useDataStore(selectProjects);
  const [works, setWorks] = useState([]);
  const [relations, setRelations] = useState([]);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [dialog, setDialog] = useState(null);
  const [evidenceWork, setEvidenceWork] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [draggingWork, setDraggingWork] = useState(null);
  const [draggedOverStatus, setDraggedOverStatus] = useState('');
  const [movingWorkId, setMovingWorkId] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([workApi.getAllWorks(), workApi.getAllWorkRelations()])
      .then(([workResponse, relationResponse]) => {
        if (!active) return;
        setWorks(workResponse?.items || []);
        setRelations(relationResponse?.items || []);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || '加载 Work Ledger 失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshVersion]);

  const relationIndex = useMemo(() => indexRelationsByWork(relations), [relations]);
  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects]);
  const filteredWorks = useMemo(
    () => filterWorkBoardItems(works, relationIndex, filters),
    [filters, relationIndex, works],
  );
  const groupedWorks = useMemo(() => groupWorksByStatus(filteredWorks), [filteredWorks]);
  useEffect(() => {
    if (selectedWorkId) return;
    onPageContextChange?.({
      page_id: 'work',
      project_id: '',
    });
  }, [onPageContextChange, selectedWorkId]);

  const refresh = () => setRefreshVersion(version => version + 1);

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
      message.warning('该状态由执行或验收流程推进，不能手动拖入');
      return;
    }

    setMovingWorkId(work.id);
    try {
      const result = await moveWorkAfterDrop(work, targetStatus);
      const actualStatus = result?.status || targetStatus;
      const targetLabel = STATUS_META[targetStatus]?.label || targetStatus;
      const actualLabel = STATUS_META[actualStatus]?.label || actualStatus;
      if (result.operation === 'enqueue') {
        message.success(`Work #${issueIdFromWorkId(work.id)} 已加入执行队列`);
      } else if (result.operation === 'retry') {
        message.success(`Work #${issueIdFromWorkId(work.id)} 已重新加入队列`);
      } else if (actualStatus === targetStatus) {
        message.success(`Work #${issueIdFromWorkId(work.id)} 已移至 ${targetLabel}`);
      } else {
        message.success(`状态门禁已将 Work 转入 ${actualLabel}`);
      }
      refresh();
    } catch (moveError) {
      message.error(`移动 Work 失败: ${moveError.message || '网络异常'}`);
    } finally {
      setMovingWorkId('');
    }
  };

  if (selectedWorkId) {
    return (
      <WorkDetail
        navigateTo={navigateTo}
        onPageContextChange={onPageContextChange}
        onWorkChanged={refresh}
        projects={projects}
        workId={selectedWorkId}
      />
    );
  }

  return (
    <section className="work-board-page">
      <WorkBoardHeader
        filteredCount={filteredWorks.length}
        loading={loading}
        onCreate={() => setDialog({ mode: 'create' })}
        onQueryChange={query => setFilters({ ...EMPTY_FILTERS, query })}
        onRefresh={refresh}
        query={filters.query}
        total={works.length}
      />

      {error ? (
        <div className="work-board-error" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>Work Ledger 暂不可用</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={refresh}>重试</button>
        </div>
      ) : (
        <div className="work-board-scroll" aria-busy={loading}>
          <div
            className="work-board-columns"
            style={{ minWidth: `${WORK_BOARD_STATUSES.length * 276}px` }}
          >
            {WORK_BOARD_STATUSES.map(status => (
              <WorkColumn
                key={status}
                dropState={workColumnDropState(draggingWork, draggedOverStatus, status)}
                draggingWorkId={draggingWork?.id || ''}
                navigateTo={navigateTo}
                onEdit={work => setDialog({ mode: 'edit', work })}
                onEvidence={setEvidenceWork}
                onDragEnd={resetDragState}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDragStart={handleDragStart}
                onDrop={handleDrop}
                projectNames={projectNames}
                relationIndex={relationIndex}
                status={status}
                movingWorkId={movingWorkId}
                works={groupedWorks.get(status) || []}
              />
            ))}
          </div>
          {loading ? <div className="work-board-loading">正在读取统一 Work Ledger…</div> : null}
        </div>
      )}

      {dialog ? (
        <WorkEditorDialog
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

      {evidenceWork ? (
        <WorkEvidenceDialog onClose={() => setEvidenceWork(null)} work={evidenceWork} />
      ) : null}
    </section>
  );
}

function WorkBoardHeader({ filteredCount, loading, onCreate, onQueryChange, onRefresh, query, total }) {
  return (
    <header className="work-ledger-header">
      <div className="work-ledger-title">
        <div className="work-ledger-kicker"><BriefcaseBusiness size={14} /> Unified work ledger</div>
        <div className="work-ledger-heading-row">
          <h1>Work Board</h1>
          <span>{filteredCount === total ? `${total} Works` : `${filteredCount} / ${total} Works`}</span>
        </div>
      </div>
      <div className="work-ledger-actions">
        <label className="work-header-search">
          <Search size={15} />
          <input
            aria-label="搜索 Work"
            onChange={event => onQueryChange(event.target.value)}
            placeholder="搜索标题、目标或 Work ID"
            type="search"
            value={query}
          />
        </label>
        <button className="work-action-secondary" disabled={loading} onClick={onRefresh} type="button">
          <RefreshCw className={loading ? 'is-spinning' : ''} size={15} /> 刷新
        </button>
        <button className="work-action-primary" onClick={onCreate} type="button">
          <Plus size={16} /> 新建 Work
        </button>
      </div>
    </header>
  );
}

function WorkColumn({
  dropState,
  draggingWorkId,
  movingWorkId,
  navigateTo,
  onDragEnd,
  onDragLeave,
  onDragOver,
  onDragStart,
  onDrop,
  onEdit,
  onEvidence,
  projectNames,
  relationIndex,
  status,
  works,
}) {
  const meta = STATUS_META[status] || { label: status, tone: 'slate' };
  return (
    <section
      className={`work-column ${dropState ? `is-drag-over is-drop-${dropState}` : ''}`.trim()}
      data-tone={meta.tone}
      onDragLeave={event => onDragLeave(event, status)}
      onDragOver={event => onDragOver(event, status)}
      onDrop={event => onDrop(event, status)}
    >
      <header className="work-column-header">
        <span className="work-column-marker" />
        <h2>{meta.label}</h2>
        <span>{works.length}</span>
      </header>
      <div className="work-column-stack">
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
            relations={relationIndex.get(work.id) || []}
            work={work}
          />
        )) : (
          <div className="work-column-empty">No Work in this lane</div>
        )}
      </div>
    </section>
  );
}

function WorkCard({ dragging, moving, navigateTo, onDragEnd, onDragStart, onEdit, onEvidence, projectName, relations, work }) {
  const issueId = issueIdFromWorkId(work.id);
  const needsAttention = workNeedsAttention(work, relations);
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
        <span className="work-type-badge">{TYPE_LABELS[work.type] || work.type}</span>
        {needsAttention ? <span className="work-attention-badge"><AlertTriangle size={12} /> Attention</span> : null}
      </div>
      <h3>{work.title}</h3>
      <p>{work.goal}</p>
      <div className="work-card-project">{projectName}</div>
      {relations.length > 0 ? (
        <div className="work-relation-row">
          {relations.slice(0, 3).map(relation => (
            <span key={relation.relation_id} data-lifecycle={relation.lifecycle}>
              {RELATION_LABELS[relation.kind] || relation.kind} · {relation.lifecycle}
            </span>
          ))}
          {relations.length > 3 ? <span>+{relations.length - 3}</span> : null}
        </div>
      ) : null}
      <div className="work-card-footer">
        <button className="work-detail-link" onClick={() => navigateTo('work', work.id)} type="button">
          Open <ArrowUpRight size={13} />
        </button>
        <button onClick={() => onEdit(work)} type="button"><Pencil size={13} /> Edit</button>
        <button className="work-evidence-link" onClick={() => onEvidence(work)} type="button">
          <ShieldCheck size={13} /> Evidence
        </button>
        {issueId ? (
          <span className="work-source-label">Issue #{issueId} authority</span>
        ) : <span className="work-source-label">{work.id}</span>}
      </div>
    </article>
  );
}

function WorkEvidenceDialog({ onClose, work }) {
  return createPortal(
    <div className="modal-overlay work-evidence-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div aria-labelledby="work-evidence-title" aria-modal="true" className="work-evidence-dialog" role="dialog">
        <header>
          <div>
            <span>WORK DECISIVE FACTS</span>
            <h2 id="work-evidence-title">{work.title}</h2>
            <p>区分 Agent 自述、兼容投影与系统可证明的结构化 Evidence。</p>
          </div>
          <button aria-label="关闭 Evidence" onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <EvidencePanel title="Work Evidence" workId={work.id} />
      </div>
    </div>,
    document.body,
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

async function moveWorkAfterDrop(work, targetStatus) {
  const issueId = issueIdFromWorkId(work.id);
  if (!issueId) throw new Error('当前 Work 没有可写的 Issue authority');
  const operation = workDropOperation(work.status, targetStatus);
  if (operation === 'none') return { operation, status: work.status };
  if (operation === 'blocked') throw new Error('该状态由执行或验收流程推进，不能手动拖入');
  let result;
  if (operation === 'enqueue') result = await workApi.enqueueIssue(issueId);
  else if (operation === 'retry') result = await workApi.retryIssue(issueId);
  else if (operation === 'cancel') result = await workApi.cancelIssue(issueId);
  else result = await workApi.updateIssue(issueId, { status: targetStatus });
  return { operation, status: result?.status || targetStatus };
}

function workColumnDropState(draggingWork, draggedOverStatus, status) {
  if (!draggingWork || draggedOverStatus !== status) return '';
  return workDropOperation(draggingWork.status, status) === 'blocked' ? 'blocked' : 'allowed';
}
