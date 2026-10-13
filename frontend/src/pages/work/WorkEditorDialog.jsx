import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Pencil, X } from 'lucide-react';
import { workApi } from '../../api/work.js';
import { projectsApi } from '../../api/projects.js';
import { systemApi } from '../../api/system.js';
import { message } from '../../store/toastStore.js';
import { useI18n } from '../../i18n/context.js';
import BatchWorkCreator from './BatchWorkCreator.jsx';
import PromptEditor from '../../components/editor/PromptEditor.jsx';
import AgentProfileSelectOptions from '../../components/AgentProfileSelectOptions.jsx';
import ModalOverlay from '../../components/ModalOverlay.jsx';
import SettingsDisclosure from '../../components/SettingsDisclosure.jsx';
import '../WorkBoard.css';
import { editorDraft, effectiveProfilePreview } from './workProfileRouting.js';
import { availableAgentProfiles, codeAgentAvailable, effectiveProjectProvider } from '../../utils/codeAgents.js';

export default function WorkEditorDialog({ mode, onClose, onSaved, projects, work, initialProject = '' }) {
  const { t } = useI18n();
  const editing = mode === 'edit';
  const [batch, setBatch] = useState(false);
  const [batchVisited, setBatchVisited] = useState(false);
  const [draft, setDraft] = useState(() => editorDraft(work, projects, initialProject));
  const createAudit = useRef(workEditorAudit('create'));
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
        setError(loadError.message || 'Code Agents 加载失败');
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
      setError('请选择当前已启用且可用的 Code Agent');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const audit = editing ? workEditorAudit('edit') : createAudit.current;
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
      const createdWork = response?.work;
      if (!createdWork?.id) throw new Error('创建结果尚未确认，请核对后再重试');
      const reason = createdWork.status === 'todo' ? selectedProject?.hold ? '项目已暂停' : selectedProject?.auto_run === 0 ? '项目未开启自动执行' : '已加入执行队列' : '';
      message.success(`${t(editing ? 'editor.updated' : 'editor.created')}${reason ? `；${reason}` : ''}`);
      onSaved(createdWork);
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
            <h2 id="work-dialog-title">{t(editing ? 'editor.edit' : 'editor.create')}</h2>
            <p>描述要做的事，默认保存为待确认。</p>
          </div>
          <button aria-label={t('editor.close')} disabled={saving} onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <form onSubmit={submit}>
          {!editing && <div className="batch-work-actions"><button className="btn btn-secondary" aria-pressed={!batch} disabled={saving} onClick={() => setBatch(false)} type="button">单个任务</button><button className="btn btn-secondary" aria-pressed={batch} disabled={saving} onClick={() => { setBatchVisited(true); setBatch(true); }} type="button">批量创建</button></div>}
          {error ? <div className="work-dialog-error" role="alert">{error}</div> : null}
          {!editing ? (
            <div className="work-dialog-grid">
              {projects.length !== 1 && <label>
                <span>{t('nav.projects')}</span>
                <select className="form-control" onChange={event => setField('project_id', event.target.value)} required value={draft.project_id}>
                  <option value="">{t('editor.selectProject')}</option>
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>}
              <label><input type="checkbox" checked={draft.status === 'todo'} onChange={event => setField('status', event.target.checked ? 'todo' : 'triage')} /> 加入执行队列</label>
            </div>
          ) : (
            <div className="work-dialog-contract">
              <span>{t(`workType.${work.type}`)}</span>
              <span>{t(`status.${work.status}`)}</span>
              <span>{t('editor.revision', { revision: work.revision })}</span>
            </div>
          )}
          {!batch && <div className="work-dialog-field">
            <span>{t('work.goal')}</span>
            <PromptEditor
              minHeight={150}
              onChange={value => setField('goal', value)}
              placeholder="描述目标、范围、验收方式；可直接粘贴或添加图片"
              value={draft.goal}
              variant="composer"
            />
          </div>}
          <SettingsDisclosure title="更多选项">
          <label>
            <span>{t('editor.title')} <small>（可选）</small></span>
            <input className="form-control" maxLength={180} onChange={event => setField('title', event.target.value)} placeholder="留空时根据问题首行生成" value={draft.title} />
          </label>
          <label>
            <span>执行预设</span>
            <select
              className="form-control"
              disabled={profilesLoading || (editing && work.status === 'in_progress')}
              onChange={event => setField('agent_profile_id', event.target.value)}
              value={draft.agent_profile_id}
            >
              <option disabled={!inheritedProviderAvailable} value="">
                {inheritedProviderAvailable ? '跟随项目设置' : '请选择可用预设'}
              </option>
              <AgentProfileSelectOptions
                catalog={providerCatalog}
                profiles={profiles}
                selectedProfileID={draft.agent_profile_id}
              />
            </select>
            <small>将使用：{effectivePreview.provider || '项目工具'} · {effectivePreview.model || '跟随编程工具'}（{effectivePreview.source === 'work' ? '任务指定' : '来自项目设置'}）</small>
          </label>
          </SettingsDisclosure>
          {batchVisited && <div hidden={!batch}><BatchWorkCreator auditFactory={() => workEditorAudit("create")} canSubmit={Boolean(draft.project_id) && selectedCodeAgentAvailable} payload={{ project_id: draft.project_id, status: draft.status, agent_profile_id: draft.agent_profile_id, type: "engineering_task" }} onBusy={setSaving} onDone={() => onSaved()} /></div>}
          {!batch && <footer>
            <button className="work-action-secondary" disabled={saving} onClick={onClose} type="button">{t('work.cancel')}</button>
            <button className="work-action-primary" disabled={saving} type="submit">
              {editing ? <Pencil size={15} /> : <CheckCircle2 size={15} />}
              {saving ? t('editor.saving') : editing ? t('editor.saveChanges') : t('editor.createAction')}
            </button>
          </footer>}
        </form>
      </div>
    </ModalOverlay>
  );
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
