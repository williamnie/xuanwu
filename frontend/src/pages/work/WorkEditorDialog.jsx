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
import { availableAgentProfiles, codeAgentAvailable, effectiveProjectProvider } from '../../utils/codeAgents.js';

export default function WorkEditorDialog({ initialProject = '', mode, onClose, onSaved, projects, work }) {
  const { t } = useI18n();
  const editing = mode === 'edit';
  const [draft, setDraft] = useState(() => editorDraft(work, projects, { initialProject, lastProject: readLastProject() }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [providerCatalog, setProviderCatalog] = useState([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const selectedProject = useMemo(
    () => projects.find(project => project.id === draft.project_id) || null,
    [draft.project_id, projects],
  );
  const effectivePreview = effectiveProfilePreview(draft.agent_profile_id, selectedProject, profiles);
  const availableProfiles = useMemo(
    () => availableAgentProfiles(profiles, providerCatalog),
    [profiles, providerCatalog],
  );
  const inheritedProviderAvailable = codeAgentAvailable(effectiveProjectProvider(selectedProject, profiles), providerCatalog);
  const selectedCodeAgentAvailable = editing && draft.agent_profile_id === (work?.agent_profile_id || '')
    ? true
    : draft.agent_profile_id
    ? availableProfiles.some(profile => profile.id === draft.agent_profile_id)
    : inheritedProviderAvailable;

  useEffect(() => {
    let alive = true;
    Promise.all([projectsApi.getAgentProfiles(), systemApi.getProviders()])
      .then(([items, catalog]) => {
        if (!alive) return;
        setProfiles(Array.isArray(items) ? items : items?.items || []);
        setProviderCatalog(Array.isArray(catalog) ? catalog : []);
      })
      .catch((loadError) => {
        if (!alive) return;
        setProfiles([]);
        setProviderCatalog([]);
        setError(loadError.message || '编程工具加载失败');
      })
      .finally(() => { if (alive) setProfilesLoading(false); });
    return () => { alive = false; };
  }, []);

  const setField = (field, value) => setDraft(current => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    if (!draft.goal.trim() || (!editing && !draft.project_id)) {
      setError(t('editor.required'));
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
          <button aria-label={t('editor.close')} disabled={saving} onClick={onClose} type="button"><X size={18} /></button>
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
              <select className="form-control" onChange={event => setField('project_id', event.target.value)} required value={draft.project_id}>
                <option value="">{t('editor.selectProject')}</option>
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
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
                disabled={profilesLoading || (editing && work.status === 'in_progress')}
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
          <p className="work-dialog-preview">{profilePreviewText(effectivePreview)}</p>
          <footer>
            <button className="work-action-secondary" disabled={saving} onClick={onClose} type="button">{t('work.cancel')}</button>
            <button className="work-action-primary" disabled={saving} type="submit">
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
