import { createPortal } from 'react-dom';
import { useState } from 'react';
import { CheckCircle2, Pencil, X } from 'lucide-react';
import { workApi } from '../../api/work.js';
import { message } from '../../store/toastStore.js';
import { useI18n } from '../../i18n/context.js';

export default function WorkEditorDialog({ mode, onClose, onSaved, projects, work }) {
  const { t } = useI18n();
  const editing = mode === 'edit';
  const [draft, setDraft] = useState(() => editorDraft(work, projects));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const setField = (field, value) => setDraft(current => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    if (!draft.title.trim() || !draft.goal.trim() || (!editing && !draft.project_id)) {
      setError(t('editor.required'));
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
      message.success(t(editing ? 'editor.updated' : 'editor.created'));
      onSaved(response?.work || null);
    } catch (saveError) {
      setError(saveError.message || t('editor.saveFailed'));
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-overlay work-dialog-overlay">
      <div aria-labelledby="work-dialog-title" aria-modal="true" className="work-dialog" role="dialog">
        <header>
          <div>
            <span>{t(editing ? 'editor.authoritativeEdit' : 'editor.auditedCreate')}</span>
            <h2 id="work-dialog-title">{t(editing ? 'editor.edit' : 'editor.create')}</h2>
            <p>{t(editing ? 'editor.editDescription' : 'editor.createDescription')}</p>
          </div>
          <button aria-label={t('editor.close')} disabled={saving} onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <form onSubmit={submit}>
          {error ? <div className="work-dialog-error" role="alert">{error}</div> : null}
          {!editing ? (
            <div className="work-dialog-grid">
              <label>
                <span>{t('nav.projects')}</span>
                <select className="form-control" onChange={event => setField('project_id', event.target.value)} required value={draft.project_id}>
                  <option value="">{t('editor.selectProject')}</option>
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <label>
                <span>{t('editor.initialStatus')}</span>
                <select className="form-control" onChange={event => setField('status', event.target.value)} value={draft.status}>
                  <option value="triage">{t('status.triage')}</option>
                  <option value="todo">{t('status.todo')}</option>
                </select>
              </label>
            </div>
          ) : (
            <div className="work-dialog-contract">
              <span>{t(`workType.${work.type}`)}</span>
              <span>{t(`status.${work.status}`)}</span>
              <span>{t('editor.revision', { revision: work.revision })}</span>
            </div>
          )}
          <label>
            <span>{t('editor.title')}</span>
            <input autoFocus className="form-control" maxLength={180} onChange={event => setField('title', event.target.value)} required value={draft.title} />
          </label>
          <label>
            <span>{t('work.goal')}</span>
            <textarea className="form-control work-goal-input" onChange={event => setField('goal', event.target.value)} required value={draft.goal} />
          </label>
          <footer>
            <button className="work-action-secondary" disabled={saving} onClick={onClose} type="button">{t('work.cancel')}</button>
            <button className="work-action-primary" disabled={saving} type="submit">
              {editing ? <Pencil size={15} /> : <CheckCircle2 size={15} />}
              {saving ? t('editor.saving') : editing ? t('editor.saveChanges') : t('editor.createAction')}
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
