import { projectOptionLabel } from '../../utils/projectOptionLabel.js';
import { useProjectNodes } from '../../store/useProjectNodes.js';
import '../WorkBoard.css';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Pencil, X } from 'lucide-react';
import { workApi } from '../../api/work.js';
import { projectsApi } from '../../api/projects.js';
import { systemApi } from '../../api/system.js';
import { message } from '../../store/toastStore.js';
import { useI18n } from '../../i18n/context.js';
import PromptEditor from '../../components/editor/PromptEditor.jsx';
import AgentProfileSelectOptions from '../../components/AgentProfileSelectOptions.jsx';
import ModalOverlay from '../../components/ModalOverlay.jsx';
import { LAST_TASK_PROJECT_KEY, editorDraft, effectiveProfilePreview, profilePreviewText } from './workProfileRouting.js';
import { workBlockReason } from '../workDetailModel.js';
import { loadWorkCatalog, workCatalogKey, workCatalogSelection } from './workEditorCatalog.js';

export default function WorkEditorDialog({ initialProject = '', mode, onClose, onSaved, projects, work }) {
  const nodesById = useProjectNodes();
  const { t } = useI18n();
  const editing = mode === 'edit';
  const [draft, setDraft] = useState(() => editorDraft(work, projects, { initialProject, lastProject: readLastProject() }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [catalogState, setCatalogState] = useState(null);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const selectedProject = useMemo(
    () => projects.find(project => project.id === draft.project_id) || null,
    [draft.project_id, projects],
  );
  const nodeId = selectedProject?.node_id || '';
  const catalogKey = workCatalogKey(draft.project_id, nodeId);
  const { profiles, catalog: providerCatalog, loading: profilesLoading, error: catalogError,
    inheritedAvailable: inheritedProviderAvailable, selectedAvailable: selectedCodeAgentAvailable,
  } = workCatalogSelection(catalogState, catalogKey, draft.agent_profile_id, selectedProject);
  const effectivePreview = effectiveProfilePreview(draft.agent_profile_id, selectedProject, profiles);
  const node = nodesById.get(nodeId);
  const nodeOffline = nodeId && (node?.online === false
    || (!node && providerCatalog.some(entry => entry.node_online === false)));

  useEffect(() => loadWorkCatalog({
    key: catalogKey,
    projectId: draft.project_id,
    getProfiles: projectsApi.getAgentProfiles,
    getProviders: systemApi.getProviders,
    publish: setCatalogState,
  }), [catalogKey, draft.project_id, catalogRetry]);

  const setField = (field, value) => setDraft(current => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    if (!draft.goal.trim() || (!editing && !draft.project_id)) {
      setError(t('editor.required'));
      return;
    }
    if (profilesLoading || catalogError) {
      setError(catalogError || '正在加载项目编程工具，请稍候');
      return;
    }
    if (!selectedCodeAgentAvailable) {
      setError('请选择当前已启用且可用的执行预设');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const audit = workEditorAudit(editing ? 'edit' : 'create');
      const agentProfilePatch = !editing || draft.agent_profile_id !== (work?.agent_profile_id || '')
        ? { agent_profile_id: draft.agent_profile_id }
        : {};
      const title = draft.title.trim();
      const response = editing
        ? await workApi.updateWork(work.id, {
          audit,
          expected_revision: work.revision,
          ...agentProfilePatch,
          goal: draft.goal.trim(),
          ...(title ? { title } : {}),
        })
        : await workApi.createWork({
          audit,
          ...agentProfilePatch,
          goal: draft.goal.trim(),
          project_id: draft.project_id,
          status: draft.status,
          ...(title ? { title } : {}),
          type: 'engineering_task',
        });
      message.success(t(editing ? 'editor.updated' : 'editor.created'));
      if (!editing) {
        rememberLastProject(draft.project_id);
        const blocked = workBlockReason({ status: draft.status }, selectedProject);
        if (blocked) message.warning(blocked);
      }
      onSaved(response?.work || null);
    } catch (saveError) {
      setError(saveError.message || t('editor.saveFailed'));
      setSaving(false);
    }
  };

  return (
    <ModalOverlay className="work-dialog-overlay">
      <div aria-labelledby="work-dialog-title" aria-modal="true" className="work-dialog" role="dialog">
        <header>
          <div>
            <span>{t(editing ? 'editor.authoritativeEdit' : 'editor.auditedCreate')}</span>
            <h2 id="work-dialog-title">{t(editing ? 'editor.edit' : 'editor.create')}</h2>
            <p>{t(editing ? 'editor.editDescription' : 'editor.createDescription')}</p>
          </div>
          <button aria-label={t('editor.close')} disabled={saving} onClick={onClose} type="button"><X size={16} /></button>
        </header>
        <form onSubmit={submit}>
          {error ? <div className="work-dialog-error" role="alert">{error}</div> : null}
          {editing ? (
            <div className="work-dialog-contract">
              <span>{t(`workType.${work.type}`)}</span>
              <span>{t(`status.${work.status}`)}</span>
              <span>{t('editor.revision', { revision: work.revision })}</span>
            </div>
          ) : projects.length > 1 ? (
            <label>
              <span>{t('nav.projects')}</span>
              <select className="form-control" disabled={saving} onChange={event => setField('project_id', event.target.value)} required value={draft.project_id}>
                <option value="">{t('editor.selectProject')}</option>
                {projects.map(project => <option key={project.id} value={project.id}>{projectOptionLabel(project, nodesById, project.name)}</option>)}
              </select>
            </label>
          ) : null}
          <div className="work-dialog-field">
            <span>{t('editor.description')}</span>
            <PromptEditor
              minHeight={150}
              onChange={value => setField('goal', value)}
              placeholder="要做什么、做到什么程度算完成；可直接粘贴或添加图片"
              value={draft.goal}
              variant="composer"
            />
          </div>
          {editing ? <TitleField onChange={value => setField('title', value)} value={draft.title} /> : null}
          {!editing ? (
            <label className="work-dialog-check">
              <input checked={draft.status === 'todo'} onChange={event => setField('status', event.target.checked ? 'todo' : 'triage')} type="checkbox" />
              <span>
                <strong>{t('editor.enqueue')}</strong>
                <small>{t('editor.enqueueHint')}</small>
              </span>
            </label>
          ) : null}
          <details className="work-dialog-more" open={!selectedCodeAgentAvailable || undefined}>
            <summary>{t('editor.moreOptions')}</summary>
            {!editing ? <TitleField onChange={value => setField('title', value)} value={draft.title} /> : null}
            <label>
              <span>{t('work.profile.preset')}</span>
              <select
                className="form-control"
                disabled={saving || profilesLoading || Boolean(catalogError) || (editing && work.status === 'in_progress')}
                onChange={event => setField('agent_profile_id', event.target.value)}
                value={draft.agent_profile_id}
              >
                <option disabled={!inheritedProviderAvailable} value="">
                  {inheritedProviderAvailable ? '跟随项目设置' : '项目默认的编程工具不可用，请选择预设'}
                </option>
                <AgentProfileSelectOptions
                  catalog={providerCatalog}
                  profiles={profiles}
                  selectedProfileID={draft.agent_profile_id}
                />
              </select>
            </label>
          </details>
          {profilesLoading ? <p className="work-dialog-preview" role="status">正在加载项目编程工具…</p> : null}
          {catalogError ? <div className="work-dialog-error" role="alert">
            {catalogError}
            <button className="work-action-secondary" onClick={() => setCatalogRetry(value => value + 1)} type="button">重试</button>
          </div> : null}
          {!profilesLoading && !catalogError && !selectedCodeAgentAvailable ? (
            <p className="work-dialog-error" role="alert">当前执行预设在所选项目上不可用，请重新选择。</p>
          ) : null}
          <p className="work-dialog-preview">
            {nodeId ? <>远程 · {node?.name || nodeId}<br /></> : null}
            {profilePreviewText(effectivePreview)}
          </p>
          {nodeOffline ? <p className="work-dialog-preview" role="status">节点离线，上线后执行</p> : null}
          <footer>
            <button className="work-action-secondary" disabled={saving} onClick={onClose} type="button">{t('work.cancel')}</button>
            <button className="work-action-primary" disabled={saving || profilesLoading || Boolean(catalogError) || !selectedCodeAgentAvailable} type="submit">
              {editing ? <Pencil size={15} /> : <CheckCircle2 size={15} />}
              {saving ? t('editor.saving') : editing ? t('editor.saveChanges') : t('editor.createAction')}
            </button>
          </footer>
        </form>
      </div>
    </ModalOverlay>
  );
}

function TitleField({ onChange, value }) {
  const { t } = useI18n();
  return (
    <label>
      <span>{t('editor.title')} <small>（可选）</small></span>
      <input className="form-control" maxLength={180} onChange={event => onChange(event.target.value)} placeholder="留空时根据描述首行生成" value={value} />
    </label>
  );
}

function readLastProject() {
  try {
    return localStorage.getItem(LAST_TASK_PROJECT_KEY) || '';
  } catch {
    return '';
  }
}

function rememberLastProject(projectId) {
  try {
    if (projectId) localStorage.setItem(LAST_TASK_PROJECT_KEY, projectId);
  } catch { /* 仅为个人便利，存储不可用时忽略。 */ }
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
