import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BriefcaseBusiness,
  CheckCircle2,
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
import { message } from '../store/toastStore';
import {
  filterWorkBoardItems,
  groupWorksByStatus,
  indexRelationsByWork,
  issueIdFromWorkId,
  WORK_BOARD_STATUSES,
  WORK_BOARD_TYPES,
  workDeliveryStage,
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

export default function WorkBoard({ navigateTo, onPageContextChange }) {
  const projects = useDataStore(selectProjects);
  const [works, setWorks] = useState([]);
  const [relations, setRelations] = useState([]);
  const [compatibility, setCompatibility] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [dialog, setDialog] = useState(null);
  const [evidenceWork, setEvidenceWork] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([workApi.getAllWorks(), workApi.getAllWorkRelations()])
      .then(([workResponse, relationResponse]) => {
        if (!active) return;
        setWorks(workResponse?.items || []);
        setRelations(relationResponse?.items || []);
        setCompatibility(workResponse?.compatibility || null);
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
  const visibleStatuses = filters.status ? [filters.status] : WORK_BOARD_STATUSES;
  const attentionCount = useMemo(
    () => works.filter(work => workNeedsAttention(work, relationIndex.get(work.id) || [])).length,
    [relationIndex, works],
  );
  const deliveredCount = useMemo(
    () => works.filter(work => workDeliveryStage(work) === 'delivered').length,
    [works],
  );

  useEffect(() => {
    onPageContextChange?.({
      page_id: 'work',
      project_id: filters.project || '',
    });
  }, [filters.project, onPageContextChange]);

  const updateFilter = (key, value) => {
    setFilters(current => ({ ...current, [key]: value }));
  };

  const refresh = () => setRefreshVersion(version => version + 1);

  return (
    <section className="work-board-page">
      <WorkBoardHeader
        attentionCount={attentionCount}
        deliveredCount={deliveredCount}
        filteredCount={filteredWorks.length}
        loading={loading}
        onCreate={() => setDialog({ mode: 'create' })}
        onRefresh={refresh}
        total={works.length}
      />

      <CompatibilityNotice compatibility={compatibility} navigateTo={navigateTo} />

      <WorkFilters
        filters={filters}
        onChange={updateFilter}
        onReset={() => setFilters(EMPTY_FILTERS)}
        projects={projects}
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
            style={{ minWidth: `${Math.max(visibleStatuses.length, 1) * 276}px` }}
          >
            {visibleStatuses.map(status => (
              <WorkColumn
                key={status}
                navigateTo={navigateTo}
                onEdit={work => setDialog({ mode: 'edit', work })}
                onEvidence={setEvidenceWork}
                projectNames={projectNames}
                relationIndex={relationIndex}
                status={status}
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

function WorkBoardHeader({ attentionCount, deliveredCount, filteredCount, loading, onCreate, onRefresh, total }) {
  return (
    <header className="work-ledger-header">
      <div className="work-ledger-title">
        <div className="work-ledger-kicker"><BriefcaseBusiness size={14} /> Unified work ledger</div>
        <h1>Work Board</h1>
        <p>把 Issue、Action、Delegation 与 Watch 放回同一条可审计工作主线。</p>
      </div>
      <div className="work-ledger-actions">
        <button className="work-action-secondary" disabled={loading} onClick={onRefresh} type="button">
          <RefreshCw className={loading ? 'is-spinning' : ''} size={15} /> 刷新
        </button>
        <button className="work-action-primary" onClick={onCreate} type="button">
          <Plus size={16} /> 新建 Work
        </button>
      </div>
      <div className="work-ledger-stats" aria-label="Work summary">
        <LedgerStat label="Total" value={total} />
        <LedgerStat label="Filtered" value={filteredCount} />
        <LedgerStat label="Attention" tone="attention" value={attentionCount} />
        <LedgerStat label="Delivered" tone="delivered" value={deliveredCount} />
      </div>
    </header>
  );
}

function LedgerStat({ label, tone = '', value }) {
  return (
    <div className={`work-ledger-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CompatibilityNotice({ compatibility, navigateTo }) {
  return (
    <div className="work-compatibility-notice">
      <div>
        <span className="work-compatibility-dot" />
        <strong>Issues remain the source of truth</strong>
        <span>
          Work 写入经兼容适配器落到 Issues；当前 shadow {compatibility?.target_shadow || 'disabled'}，无双写。
        </span>
      </div>
      <button onClick={() => navigateTo('issues')} type="button">
        打开 Issues 兼容入口 <ArrowUpRight size={14} />
      </button>
    </div>
  );
}

function WorkFilters({ filters, onChange, onReset, projects }) {
  return (
    <div className="work-filter-panel" aria-label="Work filters">
      <label className="work-search-field">
        <span>Search</span>
        <div><Search size={15} /><input onChange={event => onChange('query', event.target.value)} placeholder="标题、目标或 Work ID" value={filters.query} /></div>
      </label>
      <FilterSelect label="Type" onChange={value => onChange('type', value)} value={filters.type}>
        <option value="">All types</option>
        {WORK_BOARD_TYPES.map(type => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
      </FilterSelect>
      <FilterSelect label="Status" onChange={value => onChange('status', value)} value={filters.status}>
        <option value="">All statuses</option>
        {WORK_BOARD_STATUSES.map(status => <option key={status} value={status}>{STATUS_META[status]?.label || status}</option>)}
      </FilterSelect>
      <FilterSelect label="Project" onChange={value => onChange('project', value)} value={filters.project}>
        <option value="">All projects</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </FilterSelect>
      <FilterSelect label="Attention" onChange={value => onChange('attention', value)} value={filters.attention}>
        <option value="">Any signal</option>
        <option value="required">Needs attention</option>
        <option value="clear">Clear</option>
      </FilterSelect>
      <FilterSelect label="Delivery" onChange={value => onChange('delivery', value)} value={filters.delivery}>
        <option value="">Any delivery</option>
        <option value="outstanding">Outstanding</option>
        <option value="verification">Verification</option>
        <option value="delivered">Delivered</option>
        <option value="closed">Closed</option>
      </FilterSelect>
      <button className="work-filter-reset" onClick={onReset} type="button">Reset</button>
    </div>
  );
}

function FilterSelect({ children, label, onChange, value }) {
  return (
    <label className="work-filter-field">
      <span>{label}</span>
      <select onChange={event => onChange(event.target.value)} value={value}>{children}</select>
    </label>
  );
}

function WorkColumn({ navigateTo, onEdit, onEvidence, projectNames, relationIndex, status, works }) {
  const meta = STATUS_META[status] || { label: status, tone: 'slate' };
  return (
    <section className="work-column" data-tone={meta.tone}>
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
            onEdit={onEdit}
            onEvidence={onEvidence}
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

function WorkCard({ navigateTo, onEdit, onEvidence, projectName, relations, work }) {
  const issueId = issueIdFromWorkId(work.id);
  const needsAttention = workNeedsAttention(work, relations);
  return (
    <article className="work-card">
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
        <button onClick={() => onEdit(work)} type="button"><Pencil size={13} /> Edit</button>
        <button className="work-evidence-link" onClick={() => onEvidence(work)} type="button">
          <ShieldCheck size={13} /> Evidence
        </button>
        {issueId ? (
          <button className="work-issue-link" onClick={() => navigateTo('issues', issueId)} type="button">
            Issue #{issueId} <ArrowUpRight size={13} />
          </button>
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

function WorkEditorDialog({ mode, onClose, onSaved, projects, work }) {
  const editing = mode === 'edit';
  const [draft, setDraft] = useState(() => editorDraft(work, projects));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const setField = (field, value) => setDraft(current => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    if (!draft.title.trim() || !draft.goal.trim() || (!editing && !draft.project_id)) {
      setError('请填写标题、目标和项目。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const audit = workBoardAudit(editing ? 'edit' : 'create');
      if (editing) {
        await workApi.updateWork(work.id, {
          audit,
          expected_revision: work.revision,
          goal: draft.goal.trim(),
          title: draft.title.trim(),
        });
        message.success('Work 已更新');
      } else {
        await workApi.createWork({
          audit,
          goal: draft.goal.trim(),
          project_id: draft.project_id,
          status: draft.status,
          title: draft.title.trim(),
          type: 'engineering_task',
        });
        message.success('Work 已创建');
      }
      onSaved();
    } catch (saveError) {
      setError(saveError.message || '保存 Work 失败');
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-overlay work-dialog-overlay">
      <div aria-labelledby="work-dialog-title" aria-modal="true" className="work-dialog" role="dialog">
        <header>
          <div>
            <span>{editing ? 'ISSUE-AUTHORITATIVE EDIT' : 'AUDITED CREATE'}</span>
            <h2 id="work-dialog-title">{editing ? '编辑 Work' : '新建 Work'}</h2>
            <p>{editing ? '仅修改 Work 合同允许的标题与目标。' : '当前创建 Engineering task，并由 Issue 保持写入权威。'}</p>
          </div>
          <button aria-label="关闭" disabled={saving} onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <form onSubmit={submit}>
          {error ? <div className="work-dialog-error" role="alert">{error}</div> : null}
          {!editing ? (
            <div className="work-dialog-grid">
              <label>
                <span>Project</span>
                <select className="form-control" onChange={event => setField('project_id', event.target.value)} required value={draft.project_id}>
                  <option value="">Select project</option>
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <label>
                <span>Initial status</span>
                <select className="form-control" onChange={event => setField('status', event.target.value)} value={draft.status}>
                  <option value="triage">Triage</option>
                  <option value="todo">Todo</option>
                </select>
              </label>
            </div>
          ) : (
            <div className="work-dialog-contract">
              <span>{TYPE_LABELS[work.type] || work.type}</span>
              <span>{STATUS_META[work.status]?.label || work.status}</span>
              <span>Revision {work.revision}</span>
            </div>
          )}
          <label>
            <span>Title</span>
            <input autoFocus className="form-control" maxLength={180} onChange={event => setField('title', event.target.value)} required value={draft.title} />
          </label>
          <label>
            <span>Goal</span>
            <textarea className="form-control work-goal-input" onChange={event => setField('goal', event.target.value)} required value={draft.goal} />
          </label>
          <footer>
            <button className="work-action-secondary" disabled={saving} onClick={onClose} type="button">取消</button>
            <button className="work-action-primary" disabled={saving} type="submit">
              {editing ? <Pencil size={15} /> : <CheckCircle2 size={15} />}
              {saving ? '保存中…' : editing ? '保存修改' : '创建 Work'}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function editorDraft(work, projects) {
  return {
    goal: work?.goal || '',
    project_id: work?.owner?.project_id || projects[0]?.id || '',
    status: 'triage',
    title: work?.title || '',
  };
}

function workBoardAudit(operation) {
  const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    actor: { id: 'work-board-user', kind: 'user' },
    correlation_id: `work-board:${nonce}`,
    event_id: `work-board:${operation}:${nonce}`,
    occurred_at: new Date().toISOString(),
    reason: `User requested Work ${operation} from Work Board`,
  };
}
