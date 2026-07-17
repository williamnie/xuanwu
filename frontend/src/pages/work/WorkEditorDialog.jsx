import { createPortal } from 'react-dom';
import { useState } from 'react';
import { CheckCircle2, Pencil, X } from 'lucide-react';
import { workApi } from '../../api/work.js';
import { message } from '../../store/toastStore.js';

const TYPE_LABELS = {
  engineering_task: 'Engineering task',
  objective: 'Objective',
};

const STATUS_LABELS = {
  cancelled: 'Cancelled',
  done: 'Done',
  failed: 'Failed',
  in_progress: 'In progress',
  pending_verification: 'Verification',
  todo: 'Todo',
  triage: 'Triage',
};

export default function WorkEditorDialog({ mode, onClose, onSaved, projects, work }) {
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
      const audit = workEditorAudit(editing ? 'edit' : 'create');
      const response = editing
        ? await workApi.updateWork(work.id, {
          audit,
          expected_revision: work.revision,
          goal: draft.goal.trim(),
          title: draft.title.trim(),
        })
        : await workApi.createWork({
          audit,
          goal: draft.goal.trim(),
          project_id: draft.project_id,
          status: draft.status,
          title: draft.title.trim(),
          type: 'engineering_task',
        });
      message.success(editing ? 'Work 已更新' : 'Work 已创建');
      onSaved(response?.work || null);
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
              <span>{STATUS_LABELS[work.status] || work.status}</span>
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

function workEditorAudit(operation) {
  const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    actor: { id: 'work-board-user', kind: 'user' },
    correlation_id: `work-board:${nonce}`,
    event_id: `work-board:${operation}:${nonce}`,
    occurred_at: new Date().toISOString(),
    reason: `User requested Work ${operation} from Work Board`,
  };
}
