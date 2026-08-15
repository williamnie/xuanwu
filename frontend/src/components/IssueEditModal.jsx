import { workApi } from '../api/work.js';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Save, X } from 'lucide-react';
import PromptEditor from './editor/PromptEditor';
import AgentProfileSelectOptions from './AgentProfileSelectOptions.jsx';
import { projectsApi } from '../api/projects.js';
import { systemApi } from '../api/system.js';
import { selectProjects, useDataStore } from '../store/dataStore';
import { availableAgentProfiles, codeAgentAvailable, effectiveProjectProvider } from '../utils/codeAgents.js';
import {
  canEditIssue,
  issueDraftToPatch,
  issueToEditDraft,
  validateIssueDraft,
} from '../utils/issueEdit';
import './IssueEditModal.css';

const PRIORITY_OPTIONS = [
  { value: '0', label: '普通优先级' },
  { value: '1', label: '中优先级' },
  { value: '2', label: '紧急插队 (High)' },
];

export default function IssueEditModal({ issue, onClose, onSaved }) {
  const projects = useDataStore(selectProjects);
  const [draft, setDraft] = useState(() => issueToEditDraft(issue));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [providerCatalog, setProviderCatalog] = useState([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const selectedProject = projects.find(project => project.id === draft.project_id) || null;
  const availableProfiles = availableAgentProfiles(profiles, providerCatalog);
  const inheritedProviderAvailable = codeAgentAvailable(effectiveProjectProvider(selectedProject, profiles), providerCatalog);
  const historicalSelectionPreserved = draft.agent_profile_id
    ? draft.agent_profile_id === (issue?.agent_profile_id || '')
    : draft.project_id === (issue?.project_id || '') && !issue?.agent_profile_id;
  const selectionAvailable = historicalSelectionPreserved
    || (draft.agent_profile_id
      ? availableProfiles.some(profile => profile.id === draft.agent_profile_id)
      : inheritedProviderAvailable);

  useEffect(() => {
    setDraft(issueToEditDraft(issue));
    setError('');
    setSaving(false);
  }, [issue]);

  useEffect(() => {
    let alive = true;
    setProfilesLoading(true);
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
  }, [issue?.id]);

  const setField = (field, value) => {
    setDraft(current => ({ ...current, [field]: value }));
  };

  const submitEdit = async (event) => {
    event.preventDefault();
    const validationError = editValidationError(issue, draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!selectionAvailable) {
      setError('请选择当前已启用且可用的 Code Agent');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updatedIssue = await workApi.updateIssue(issue.id, issueDraftToPatch(draft));
      onSaved(updatedIssue);
    } catch (err) {
      setError(err.message || '保存 Issue 失败');
      setSaving(false);
    }
  };

  if (!canEditIssue(issue)) return null;

  return createPortal(
    <div className="modal-overlay">
      <div className="glass-card modal-content issue-edit-modal">
        <ModalHeader issue={issue} onClose={onClose} />
        <form className="issue-edit-modal__form" onSubmit={submitEdit}>
          {error && <EditError message={error} />}
          <ProjectField projects={projects} value={draft.project_id} onChange={(value) => setField('project_id', value)} />
          <AgentProfileField
            catalog={providerCatalog}
            inheritedProviderAvailable={inheritedProviderAvailable}
            loading={profilesLoading}
            profiles={profiles}
            value={draft.agent_profile_id}
            onChange={(value) => setField('agent_profile_id', value)}
          />
          <TitleField value={draft.title} onChange={(value) => setField('title', value)} />
          <DescriptionField value={draft.description} onChange={(value) => setField('description', value)} />
          <PriorityField value={draft.priority} onChange={(value) => setField('priority', value)} />
          <ModalActions saving={saving} onClose={onClose} />
        </form>
      </div>
    </div>,
    document.body,
  );
}

function AgentProfileField({ catalog, inheritedProviderAvailable, loading, onChange, profiles, value }) {
  return (
    <div className="form-group">
      <label>Code Agent</label>
      <select className="form-control" disabled={loading} value={value} onChange={(event) => onChange(event.target.value)}>
        <option disabled={!inheritedProviderAvailable} value="">
          {inheritedProviderAvailable ? '继承项目默认' : '请选择可用 Code Agent'}
        </option>
        <AgentProfileSelectOptions catalog={catalog} profiles={profiles} selectedProfileID={value} />
      </select>
      <span className="issue-edit-modal__help">
        历史选择当前不可用时会保留显示；只有改选时才要求 Code Agent 已就绪。
      </span>
    </div>
  );
}

function ProjectField({ projects, value, onChange }) {
  return (
    <div className="form-group">
      <label>关联目标项目 *</label>
      <select className="form-control" value={value} onChange={(event) => onChange(event.target.value)} required>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
      </select>
    </div>
  );
}

function editValidationError(issue, draft) {
  if (!canEditIssue(issue)) {
    return '只有 Triage 状态的 Issue 可以编辑';
  }
  return validateIssueDraft(draft);
}

function ModalHeader({ issue, onClose }) {
  return (
    <div className="issue-edit-modal__header">
      <div>
        <h3 className="issue-edit-modal__title">编辑 Triage Issue #{issue.id}</h3>
        <p className="issue-edit-modal__description">
          修改会直接保存到运行前的 Issue 内容；进入 Todo / In Progress 后不再开放编辑。
        </p>
      </div>
      <button className="issue-edit-modal__close" type="button" onClick={onClose}>
        <X size={18} />
      </button>
    </div>
  );
}

function TitleField({ value, onChange }) {
  return (
    <div className="form-group">
      <label>任务标题（可选，留空会从内容首行自动生成）</label>
      <input
        type="text"
        className="form-control"
        placeholder="例如：修复 Triage issue 编辑入口"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function DescriptionField({ value, onChange }) {
  return (
    <div className="form-group">
      <label>任务内容 / 需求描述 *</label>
      <PromptEditor
        placeholder="更新要 Codex 执行的完整内容，例如复现路径、期望改动和验证方式..."
        value={value}
        onChange={onChange}
        minHeight={160}
        hideToolbar={true}
      />
    </div>
  );
}

function PriorityField({ value, onChange }) {
  return (
    <div className="form-group">
      <label>任务优先级</label>
      <select className="form-control" value={value} onChange={(event) => onChange(event.target.value)}>
        {PRIORITY_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function EditError({ message }) {
  return (
    <div className="issue-edit-modal__error">
      {message}
    </div>
  );
}

function ModalActions({ saving, onClose }) {
  return (
    <div className="issue-edit-modal__actions">
      <button type="button" className="btn btn-secondary issue-edit-modal__cancel" onClick={onClose} disabled={saving}>
        取消
      </button>
      <button type="submit" className="btn btn-primary issue-edit-modal__submit" disabled={saving}>
        <Save size={14} /> {saving ? '保存中...' : '保存修改'}
      </button>
    </div>
  );
}
