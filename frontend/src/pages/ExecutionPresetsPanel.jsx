import { useProjectPresetCatalog } from './useProjectPresetCatalog.js';
import { projectOptionLabel } from '../utils/projectOptionLabel.js';
import { useProjectNodes } from '../store/useProjectNodes.js';
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { projectsApi } from '../api/projects.js';
import { systemApi } from '../api/system.js';
import { selectProjects, selectRefreshData, useDataStore } from '../store/dataStore.js';
import { message } from '../store/toastStore.js';
import { agentProfilePayload, emptyAgentProfileForm, normalizeAgentProfileForm } from '../utils/agentProfiles.js';
import { availableAgentProfiles } from '../utils/codeAgents.js';
import AgentProfileSelectOptions from '../components/AgentProfileSelectOptions.jsx';
import AgentProfileManager from './AgentProfileManager.jsx';
import { providerOptionsFromCatalog } from './sessions/sessionOptions.js';
import { buildProviderModelOptions, normalizeProviderModel } from './projectModelOptions.js';

export default function ExecutionPresetsPanel() {
  const nodesById = useProjectNodes();
  const { language } = useI18n();
  const english = language === 'en-US';
  const projects = useDataStore(selectProjects);
  const refreshData = useDataStore(selectRefreshData);
  const [profiles, setProfiles] = useState([]);
  const [providerCatalog, setProviderCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyAgentProfileForm);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [projectID, setProjectID] = useState('');
  const [profileID, setProfileID] = useState('');
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [assignmentError, setAssignmentError] = useState('');
  const project = projects.find(item => item.id === projectID);
  const assignmentCatalog = useProjectPresetCatalog(project?.node_id || '', providerCatalog);
  const providerOptions = providerOptionsFromCatalog(providerCatalog);

  useEffect(() => {
    let active = true;
    Promise.all([projectsApi.getAgentProfiles(), systemApi.getProviders()])
      .then(([list, catalog]) => {
        if (!active) return;
        setProfiles(list || []);
        setProviderCatalog(catalog || []);
      })
      .catch(error => { if (active) setError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setModels([]);
    setModelsLoading(true);
    setModelsError('');
    systemApi.getProviderModels(form.provider).then(result => {
      if (!active) return;
      const data = Array.isArray(result?.data?.data) ? result.data.data : result?.data;
      setModels(Array.isArray(data) ? data : []);
    }).catch(error => { if (active) setModelsError(error.message); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [form.provider]);

  const handleProfileSubmit = async () => {
    const payload = agentProfilePayload(form);
    if (!payload.name) {
      setError(english ? 'Enter a preset name.' : '请填写预设名称。');
      return;
    }
    const existing = profiles.find(profile => profile.id === payload.id);
    if (!providerOptions.some(option => option.value === payload.provider) && existing?.provider !== payload.provider) {
      setError(english ? 'Choose an enabled, available coding tool.' : '请选择当前已启用且可用的编程工具。');
      return;
    }
    setError('');
    setSaving(true);
    try {
      if (Object.keys(payload.execution_policy).length > 0) {
        const preview = await systemApi.resolveProviderExecutionPolicy(payload.provider, {
          project_id: projectID,
          policy: payload.execution_policy,
        });
        if (preview?.supported === false) throw new Error(preview.reason || (english ? 'This execution policy is unsupported.' : '当前编程工具不支持所选执行策略。'));
      }
      const saved = existing
        ? await projectsApi.updateAgentProfile(payload.id, payload)
        : await projectsApi.createAgentProfile(payload);
      setProfiles(current => [...current.filter(profile => profile.id !== saved.id), saved]);
      setForm(normalizeAgentProfileForm(saved));
      message.success(english ? 'Preset saved.' : '执行预设已保存。');
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const saveProjectPreset = async () => {
    if (!project || assignmentCatalog.loading || assignmentCatalog.error) return;
    const changed = profileID !== (project.default_agent_profile_id || '');
    if (changed && profileID && !availableAgentProfiles(profiles, assignmentCatalog.catalog).some(profile => profile.id === profileID)) {
      setAssignmentError(english ? 'Choose an available preset or use project defaults.' : '请选择可用预设，或沿用项目设置。');
      return;
    }
    setAssignmentError('');
    setAssignmentSaving(true);
    try {
      await projectsApi.updateProject(projectID, { default_agent_profile_id: profileID });
      await refreshData(['projects']);
      message.success(english ? 'Project preset saved.' : '项目执行预设已保存。');
    } catch (error) {
      setAssignmentError(error.message);
    } finally {
      setAssignmentSaving(false);
    }
  };

  return (
    <div className="project-profile-fields">
      <section className="project-profile-manager">
        <h3 className="settings-subsection-title">{english ? 'Project preset' : '项目执行预设'}</h3>
        <p className="project-profile-copy">{english ? 'Choose which preset a project uses by default. Task overrides still take priority.' : '选择项目默认使用的预设；任务单独指定的预设仍优先。'}</p>
        <div className="project-settings-grid">
          <label className="form-group"><span className="ds-mono-label">{english ? 'Project' : '项目'}</span>
            <select className="form-control" value={projectID} disabled={assignmentSaving} onChange={event => {
              const id = event.target.value;
              setProjectID(id);
              setProfileID(projects.find(item => item.id === id)?.default_agent_profile_id || '');
              setAssignmentError('');
            }}>
              <option value="">{english ? 'Select a project' : '选择项目'}</option>
              {projects.map(project => <option key={project.id} value={project.id}>{projectOptionLabel(project, nodesById, project.name)}</option>)}
            </select>
          </label>
          <label className="form-group"><span className="ds-mono-label">{english ? 'Execution preset' : '执行预设'}</span>
            <select className="form-control" value={profileID} disabled={!project || loading || assignmentSaving || assignmentCatalog.loading || Boolean(assignmentCatalog.error)} onChange={event => setProfileID(event.target.value)}>
              <option value="">{english ? 'Use project defaults' : '沿用项目设置'}</option>
              <AgentProfileSelectOptions catalog={assignmentCatalog.catalog} profiles={profiles} selectedProfileID={profileID} />
            </select>
          </label>
        </div>
        {assignmentCatalog.error ? <p className="project-profile-error" role="alert">{assignmentCatalog.error}</p> : null}
        {assignmentError ? <p className="project-profile-error" role="alert">{assignmentError}</p> : null}
        <div className="project-profile-actions">
          <button className="btn btn-secondary" type="button" disabled={!project || loading || assignmentSaving || assignmentCatalog.loading || Boolean(assignmentCatalog.error)} onClick={saveProjectPreset}>{english ? 'Save project preset' : '保存项目预设'}</button>
        </div>
      </section>
      <AgentProfileManager
        profiles={profiles} loading={loading} saving={saving} form={form} error={error}
        models={models} modelsLoading={modelsLoading} modelsError={modelsError}
        modelOptions={buildProviderModelOptions(form.provider, models, [form.model], language)}
        providerCatalog={providerCatalog} providerOptions={providerOptions}
        onFieldChange={(field, value) => setForm(current => field === 'provider'
          ? { ...current, provider: value, model: normalizeProviderModel(value, ''), reasoning_effort: '', service_tier: '' }
          : { ...current, [field]: value })}
        onSubmit={handleProfileSubmit}
        onEdit={profile => { setForm(normalizeAgentProfileForm(profile)); setError(''); }}
        onReset={() => { setForm(emptyAgentProfileForm()); setError(''); }}
      />
    </div>
  );
}
