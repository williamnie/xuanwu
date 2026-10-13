import { useEffect, useState } from 'react';
import { projectsApi } from '../api/projects.js';
import { systemApi } from '../api/system.js';
import { agentProfilePayload, emptyAgentProfileForm, normalizeAgentProfileForm } from '../utils/agentProfiles.js';
import { providerOptionsFromCatalog } from './sessions/sessionOptions.js';
import { AgentProfileManager } from './ProjectSettingsEditor.jsx';
import { message } from '../store/toastStore.js';

export default function ExecutionPresetsPanel() {
  const [state, setState] = useState({ profiles: [], catalog: [], loading: true, saving: false, error: '' });
  const [form, setForm] = useState(emptyAgentProfileForm);
  const [models, setModels] = useState({ data: [], error: '', loading: false });
  const load = async () => {
    setState(current => ({ ...current, loading: true }));
    try {
      const [profiles, catalog] = await Promise.all([projectsApi.getAgentProfiles(), systemApi.getProviders()]);
      setState(current => ({ ...current, profiles, catalog, error: '', loading: false }));
    } catch (error) { setState(current => ({ ...current, error: error.message, loading: false })); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    let alive = true;
    setModels({ data: [], error: '', loading: true });
    systemApi.getProviderModels(form.provider).then(result => {
      if (!alive) return;
      const data = Array.isArray(result?.data?.data) ? result.data.data : result?.data;
      setModels({ data: Array.isArray(data) ? data : [], error: '', loading: false });
    }).catch(error => { if (alive) setModels({ data: [], error: error.message, loading: false }); });
    return () => { alive = false; };
  }, [form.provider]);
  const onFieldChange = (field, value) => setForm(current => ({ ...current, [field]: value, ...(field === 'provider' ? { model: value === 'codex' ? 'codex-default' : '' } : {}) }));
  const save = async event => {
    event?.preventDefault?.();
    if (state.saving) return;
    const payload = agentProfilePayload(form);
    if (!payload.name) { setState(current => ({ ...current, error: '请填写预设名称' })); return; }
    const existing = state.profiles.find(profile => profile.id === payload.id);
    if (!providerOptionsFromCatalog(state.catalog).some(option => option.value === payload.provider) && existing?.provider !== payload.provider) {
      setState(current => ({ ...current, error: '请选择已就绪的编程工具' })); return;
    }
    setState(current => ({ ...current, saving: true, error: '' }));
    try {
      if (payload.execution_policy && Object.keys(payload.execution_policy).length) {
        const preview = await systemApi.resolveProviderExecutionPolicy(payload.provider, { policy: payload.execution_policy });
        if (preview?.supported === false) throw new Error(preview.reason || '工具不支持该执行权限');
      }
      if (existing) await projectsApi.updateAgentProfile(payload.id, payload);
      else await projectsApi.createAgentProfile(payload);
      message.success('执行预设已保存');
      await load();
    } catch (error) { setState(current => ({ ...current, error: error.message })); }
    finally { setState(current => ({ ...current, saving: false })); }
  };
  const modelOptions = [{ value: form.provider === 'codex' ? 'codex-default' : '', label: '跟随编程工具' }, ...models.data.map(model => ({ value: model.id || model.model, label: model.displayName || model.id || model.model }))];
  if (form.model && !modelOptions.some(option => option.value === form.model)) modelOptions.push({ value: form.model, label: `${form.model}（当前选择）` });
  return <fieldset disabled={state.saving} className="execution-presets-panel">
    <AgentProfileManager profiles={state.profiles} loading={state.loading} form={form} error={state.error} modelOptions={modelOptions} models={models.data} modelsError={models.error} modelsLoading={models.loading} onFieldChange={onFieldChange} onSubmit={save} onEdit={profile => setForm(normalizeAgentProfileForm(profile))} onReset={() => setForm(emptyAgentProfileForm())} providerCatalog={state.catalog} providerOptions={providerOptionsFromCatalog(state.catalog)} />
  </fieldset>;
}
