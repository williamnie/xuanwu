import { useCallback, useEffect } from 'react';
import { useImmer } from 'use-immer';
import { systemApi } from '../api/system.js';
import { projectsApi } from '../api/projects.js';
import { message } from '../store/toastStore.js';
import {
  agentProfilePayload,
  emptyAgentProfileForm,
  normalizeAgentProfileForm,
} from '../utils/agentProfiles.js';
import { serviceTierOptions } from '../utils/serviceTier.js';
import { availableAgentProfiles, codeAgentLabel } from '../utils/codeAgents.js';
import { providerOptionsFromCatalog } from './sessions/sessionOptions.js';
import AgentProfileSelectOptions from '../components/AgentProfileSelectOptions.jsx';
import {
  executionPolicyPayload,
  executionPolicyPresets,
  executionPolicyValue,
  isolationLabel,
  policyFromValue,
  projectExecutionPolicy,
} from '../utils/executionPolicy.js';
import './ProjectSettingsEditor.css';

const DEFAULT_PROJECT_NAME = 'project';
const DEFAULT_CODEX_MODEL = 'codex-default';
const DEFAULT_PROVIDER = 'codex';

function projectNameFromPath(cwd = '') {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || DEFAULT_PROJECT_NAME;
}

function projectIdFromPath(cwd) {
  const base = projectNameFromPath(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return base.replace(/^-+|-+$/g, '') || DEFAULT_PROJECT_NAME;
}

function normalizeProviderModel(provider, model) {
  const value = String(model || '').trim();
  return value || (provider === DEFAULT_PROVIDER ? DEFAULT_CODEX_MODEL : '');
}

function buildProviderModelOptions(provider, models, ...selectedValues) {
  const options = [];
  const seen = new Set();
  const pushOption = (value, label) => {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue || seen.has(normalizedValue)) return;
    seen.add(normalizedValue);
    options.push({ value: normalizedValue, label: String(label || normalizedValue).trim() || normalizedValue });
  };

  if (provider === DEFAULT_PROVIDER) {
    pushOption(DEFAULT_CODEX_MODEL, '系统默认模型');
  } else {
    seen.add('');
    options.push({ value: '', label: 'Provider 默认模型' });
  }
  const liveModels = Array.isArray(models) ? models.filter(model => !model?.hidden) : [];
  liveModels.forEach(model => pushOption(model?.id || model?.model, model?.displayName || model?.name || model?.id || model?.model));
  selectedValues.forEach(value => {
    const normalizedValue = normalizeProviderModel(provider, value);
    if (normalizedValue !== DEFAULT_CODEX_MODEL) pushOption(normalizedValue, normalizedValue);
  });
  return options;
}

function projectForm(project) {
  const executionPolicy = projectExecutionPolicy(project);
  return {
    formAgentProfileId: project?.default_agent_profile_id || '',
    formApproval: project?.approval_policy || 'never',
    formCwd: project?.cwd || '',
    formModel: normalizeProviderModel(project?.provider || DEFAULT_PROVIDER, project?.model),
    formProvider: project?.provider || DEFAULT_PROVIDER,
    formProviderConfig: project?.provider_config_json || '{}',
    formSandbox: project?.sandbox || 'workspace-write',
    formExecutionPolicy: executionPolicy,
    formServiceTier: project?.default_service_tier || '',
  };
}

function initialEditorState(project) {
  return {
    ...projectForm(project),
    codexModels: [],
    codexModelsError: '',
    codexModelsLoading: false,
    formError: '',
    profileError: '',
    profileForm: emptyAgentProfileForm(),
    profiles: [],
    profilesLoading: false,
    providerCatalog: [],
    providerCatalogError: '',
    providerCatalogLoading: true,
    saving: false,
  };
}

export default function ProjectSettingsEditor({ layout = 'inline', mode = 'edit', onCancel, onSaved, project = null }) {
  const [ui, updateUi] = useImmer(() => initialEditorState(project));
  const projectID = project?.id || '';

  const loadAgentProfiles = useCallback(async () => {
    updateUi(draft => {
      draft.profilesLoading = true;
      draft.profileError = '';
    });
    try {
      const list = await projectsApi.getAgentProfiles();
      updateUi(draft => {
        draft.profiles = list || [];
      });
    } catch (error) {
      updateUi(draft => {
        draft.profileError = error.message || '加载 Agent Profile 失败';
      });
    } finally {
      updateUi(draft => {
        draft.profilesLoading = false;
      });
    }
  }, [updateUi]);

  const loadProviderModels = useCallback(async (provider = DEFAULT_PROVIDER) => {
    updateUi(draft => {
      draft.codexModelsLoading = true;
      draft.codexModelsError = '';
    });
    try {
      const result = await systemApi.getProviderModels(provider);
      updateUi(draft => {
        const data = Array.isArray(result?.data?.data) ? result.data.data : result?.data;
        draft.codexModels = Array.isArray(data) ? data : [];
      });
    } catch (error) {
      updateUi(draft => {
        draft.codexModels = [];
        draft.codexModelsError = error.message || '读取 Provider 模型列表失败';
      });
    } finally {
      updateUi(draft => {
        draft.codexModelsLoading = false;
      });
    }
  }, [updateUi]);

  const loadProviderCatalog = useCallback(async () => {
    updateUi(draft => {
      draft.providerCatalogError = '';
      draft.providerCatalogLoading = true;
    });
    try {
      const catalog = await systemApi.getProviders();
      const providerOptions = providerOptionsFromCatalog(catalog);
      const requestedProvider = project?.provider || DEFAULT_PROVIDER;
      const selectedProvider = mode === 'create' && !providerOptions.some(option => option.value === requestedProvider)
        ? providerOptions[0]?.value || ''
        : requestedProvider;
      updateUi(draft => {
        draft.providerCatalog = Array.isArray(catalog) ? catalog : [];
        draft.providerCatalogError = '';
        draft.providerCatalogLoading = false;
        if (mode === 'create' && selectedProvider !== draft.formProvider) {
          draft.formProvider = selectedProvider;
          draft.formModel = normalizeProviderModel(selectedProvider, '');
        }
      });
      if (selectedProvider) await loadProviderModels(selectedProvider);
    } catch (error) {
      updateUi(draft => {
        draft.providerCatalog = [];
        draft.providerCatalogError = error.message || '读取 Provider 列表失败';
        draft.providerCatalogLoading = false;
      });
    }
  }, [loadProviderModels, mode, project?.provider, updateUi]);

  useEffect(() => {
    loadProviderCatalog();
    if (mode === 'edit') loadAgentProfiles();
  }, [loadAgentProfiles, loadProviderCatalog, loadProviderModels, mode, project?.provider]);

  useEffect(() => {
    updateUi(draft => {
      Object.assign(draft, projectForm(project));
      draft.formError = '';
    });
  }, [mode, project, projectID, updateUi]);

  const setFormField = (field, value) => {
    updateUi(draft => {
      draft[field] = value;
    });
  };

  const setProjectRuntimeField = (field, value) => {
    if (field !== 'formProvider') {
      setFormField(field, value);
      return;
    }
    updateUi(draft => {
      draft.formProvider = value;
      draft.formModel = normalizeProviderModel(value, '');
      draft.formServiceTier = '';
    });
    loadProviderModels(value);
  };

  const setProfileFormField = (field, value) => {
    updateUi(draft => {
      draft.profileForm[field] = value;
      if (field === 'provider') {
        draft.profileForm.model = normalizeProviderModel(value, '');
      }
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!ui.formCwd.trim()) {
      updateUi(draft => {
        draft.formError = '项目路径不能为空';
      });
      return;
    }
    const providerChanged = ui.formProvider !== (project?.provider || DEFAULT_PROVIDER);
    if (!providerOptions.some(option => option.value === ui.formProvider) && (mode === 'create' || providerChanged)) {
      updateUi(draft => {
        draft.formError = '请选择当前已启用且可用的 Code Agent';
      });
      return;
    }
    const profileChanged = ui.formAgentProfileId !== (project?.default_agent_profile_id || '');
    if (ui.formAgentProfileId && !availableProfiles.some(profile => profile.id === ui.formAgentProfileId) && profileChanged) {
      updateUi(draft => {
        draft.formError = '项目默认 Profile 的 Code Agent 当前不可用，请改选可用 Profile 或清除默认 Profile';
      });
      return;
    }

    const payload = {
      name: projectNameFromPath(ui.formCwd),
      cwd: ui.formCwd,
      provider: ui.formProvider,
      provider_config_json: ui.formProviderConfig,
      model: normalizeProviderModel(ui.formProvider, ui.formModel),
      approval_policy: ui.formApproval,
      sandbox: ui.formSandbox,
      execution_policy: executionPolicyPayload(ui.formExecutionPolicy),
      default_service_tier: ui.formServiceTier,
      default_agent_profile_id: ui.formAgentProfileId,
    };

    updateUi(draft => {
      draft.formError = '';
      draft.saving = true;
    });
    try {
      const preview = await systemApi.resolveProviderExecutionPolicy(ui.formProvider, {
        project_id: projectID,
        policy: executionPolicyPayload(ui.formExecutionPolicy),
      });
      if (preview?.supported === false) throw new Error(preview.reason || '当前 Provider 不支持所选执行策略');
      const saved = mode === 'create'
        ? await projectsApi.createProject({ id: projectIdFromPath(ui.formCwd), ...payload })
        : await projectsApi.updateProject(projectID, payload);
      message.success(mode === 'create' ? '项目已创建并接管' : '项目设置已保存');
      await onSaved?.(saved);
    } catch (error) {
      updateUi(draft => {
        draft.formError = error.message || '操作失败';
      });
    } finally {
      updateUi(draft => {
        draft.saving = false;
      });
    }
  };

  const handleProfileSubmit = async (event) => {
    event?.preventDefault?.();
    const payload = agentProfilePayload(ui.profileForm);
    if (!payload.name) {
      updateUi(draft => {
        draft.profileError = 'Profile 名称不能为空';
      });
      return;
    }
    const existing = ui.profiles.find(profile => profile.id === payload.id);
    const historicalProviderPreserved = existing?.provider === payload.provider;
    if (!providerOptions.some(option => option.value === payload.provider) && !historicalProviderPreserved) {
      updateUi(draft => {
        draft.profileError = 'Profile 必须选择当前已启用且可用的 Code Agent';
      });
      return;
    }
    try {
      if (payload.execution_policy && Object.keys(payload.execution_policy).length > 0) {
        const preview = await systemApi.resolveProviderExecutionPolicy(payload.provider, {
          project_id: projectID,
          policy: payload.execution_policy,
        });
        if (preview?.supported === false) throw new Error(preview.reason || '当前 Provider 不支持所选 Profile 执行策略');
      }
      const saved = existing
        ? await projectsApi.updateAgentProfile(payload.id, payload)
        : await projectsApi.createAgentProfile(payload);
      updateUi(draft => {
        draft.profileForm = emptyAgentProfileForm();
        draft.formAgentProfileId = saved.id;
      });
      await loadAgentProfiles();
    } catch (error) {
      updateUi(draft => {
        draft.profileError = error.message || '保存 Agent Profile 失败';
      });
    }
  };

  const discoveredProviderOptions = providerOptionsFromCatalog(ui.providerCatalog);
  const providerOptions = discoveredProviderOptions;
  const availableProfiles = availableAgentProfiles(ui.profiles, ui.providerCatalog);
  const modelOptions = buildProviderModelOptions(ui.formProvider, ui.codexModels, ui.formModel, ui.profileForm.model);
  const modal = layout === 'modal';
  const providerReady = providerOptions.some(option => option.value === ui.formProvider);
  const historicalProviderPreserved = mode === 'edit' && ui.formProvider === (project?.provider || DEFAULT_PROVIDER);

  return (
    <form className={modal ? 'project-config-modal-form' : 'project-settings-editor-form'} onSubmit={handleSubmit}>
      <div className={modal ? 'project-config-modal-body' : 'project-settings-editor-body'}>
        {ui.formError && <div className="project-settings-error" role="alert">{ui.formError}</div>}

        <div className="form-group">
          <label>项目路径 *</label>
          <input
            autoFocus={mode === 'create'}
            className="form-control"
            onChange={event => setFormField('formCwd', event.target.value)}
            placeholder="/Users/username/projects/project-name"
            required
            type="text"
            value={ui.formCwd}
          />
          <span className="project-settings-hint">
            填写项目根目录的绝对路径。项目名称会自动识别为：{ui.formCwd.trim() ? projectNameFromPath(ui.formCwd) : '—'}
          </span>
        </div>

        {mode === 'create' ? (
          <details className="project-settings-advanced">
            <summary>高级运行配置（可选）</summary>
            <p>不确定时无需修改。默认使用无人值守开发策略，允许当前 Provider 使用本机开发能力且不逐次等待确认。</p>
            <ProjectRuntimeFields modelOptions={modelOptions} onFieldChange={setProjectRuntimeField} providerOptions={providerOptions} ui={ui} />
          </details>
        ) : (
          <>
            <ProjectRuntimeFields modelOptions={modelOptions} onFieldChange={setProjectRuntimeField} providerOptions={providerOptions} ui={ui} />
            <details className="project-settings-advanced project-profile-settings">
              <summary>Agent Profile（可选）</summary>
              <p>只有需要复用一组模型、权限或指令预设时才配置；普通项目可以完全忽略。</p>
              <div className="form-group">
                <label>项目默认 Profile</label>
                <select className="form-control" onChange={event => setFormField('formAgentProfileId', event.target.value)} value={ui.formAgentProfileId}>
                  <option value="">不使用 Profile（沿用项目运行配置）</option>
                  <AgentProfileSelectOptions
                    catalog={ui.providerCatalog}
                    profiles={ui.profiles}
                    selectedProfileID={ui.formAgentProfileId}
                  />
                </select>
              </div>
              <AgentProfileManager
                error={ui.profileError}
                form={ui.profileForm}
                loading={ui.profilesLoading}
                modelOptions={modelOptions}
                models={ui.codexModels}
                modelsError={ui.codexModelsError || (ui.profileForm.provider !== ui.formProvider ? '当前 Profile 使用其他 Provider' : '')}
                modelsLoading={ui.codexModelsLoading}
                onEdit={profile => updateUi(draft => { draft.profileForm = normalizeAgentProfileForm(profile); draft.profileError = ''; })}
                onFieldChange={setProfileFormField}
                onReset={() => updateUi(draft => { draft.profileForm = emptyAgentProfileForm(); draft.profileError = ''; })}
                onSubmit={handleProfileSubmit}
                providerOptions={providerOptions}
                providerCatalog={ui.providerCatalog}
                profiles={ui.profiles}
              />
            </details>
          </>
        )}
      </div>

      <div className={modal ? 'project-config-modal-footer' : 'project-settings-editor-footer'}>
        {onCancel && <button className="btn btn-secondary" disabled={ui.saving} onClick={onCancel} type="button">取消</button>}
        <button className="btn btn-primary" disabled={ui.saving || ui.providerCatalogLoading || (!providerReady && !historicalProviderPreserved)} type="submit">
          {ui.saving ? '正在保存…' : mode === 'create' ? '添加并接管' : '保存项目设置'}
        </button>
      </div>
    </form>
  );
}

function ProjectRuntimeFields({ modelOptions, onFieldChange, providerOptions, ui }) {
  const providerReady = providerOptions.some(option => option.value === ui.formProvider);
  const providerSelectDisabled = ui.providerCatalogLoading || Boolean(ui.providerCatalogError) || providerOptions.length === 0;
  const policyOptions = executionPolicyPresets(ui.providerCatalog, ui.formProvider, ui.formExecutionPolicy);
  const policyValue = executionPolicyValue(ui.formExecutionPolicy);

  return (
    <div className="project-runtime-fields">
      <div className="form-group">
        <label>执行引擎</label>
        <select
          aria-busy={ui.providerCatalogLoading}
          className={`form-control${ui.providerCatalogLoading ? ' project-settings-control-loading' : ''}`}
          disabled={providerSelectDisabled}
          onChange={event => onFieldChange('formProvider', event.target.value)}
          value={ui.formProvider}
        >
          {ui.providerCatalogLoading && <option value="">正在读取可用执行引擎…</option>}
          {!ui.providerCatalogLoading && ui.providerCatalogError && <option value="">执行引擎加载失败</option>}
          {!ui.providerCatalogLoading && !ui.providerCatalogError && providerOptions.length === 0 && <option value="">暂无可用执行引擎</option>}
          {!ui.providerCatalogLoading && !ui.providerCatalogError && ui.formProvider && !providerReady && (
            <option disabled value={ui.formProvider}>{codeAgentLabel(ui.formProvider, ui.providerCatalog)}（不可用）</option>
          )}
          {providerOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <span
          aria-live="polite"
          className={`project-settings-hint${ui.providerCatalogLoading ? ' project-settings-loading-hint' : ''}${ui.providerCatalogError || (!ui.providerCatalogLoading && !providerReady) ? ' project-settings-hint-error' : ''}`}
          role="status"
        >
          {ui.providerCatalogLoading
            ? '正在读取已启用且可用的 Code Agent…'
            : ui.providerCatalogError
              ? `读取执行引擎失败：${ui.providerCatalogError}`
              : !providerReady
                ? '项目原执行引擎当前不可用，请从可用列表中重新选择。'
                : '决定由哪个执行器处理项目；通常保持 Codex。'}
        </span>
      </div>

      <div className="project-settings-grid">
        <div className="form-group">
          <label>默认模型</label>
          {ui.formProvider === 'qoder' || ui.codexModelsError ? (
            <>
              <input className="form-control" list="project-provider-model-suggestions" onChange={event => onFieldChange('formModel', event.target.value)} placeholder="Provider 默认，或手动填写 model ID" value={ui.formModel} />
              <datalist id="project-provider-model-suggestions">
                {modelOptions.filter(option => option.value).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </datalist>
            </>
          ) : (
            <select className="form-control" disabled={ui.codexModelsLoading} onChange={event => onFieldChange('formModel', event.target.value)} value={ui.formModel}>
              {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          )}
          <span className="project-settings-hint">
            {ui.codexModelsLoading
                ? '正在读取 Provider 模型列表…'
              : ui.codexModelsError
                ? `远端 model API 读取失败，已启用手填：${ui.codexModelsError}`
                : ui.formProvider === 'qoder' && ui.codexModels.some(model => model?.verified === false)
                  ? 'Qoder 账号发现不可用；候选仅是静态建议，当前值保留为未验证手工 model ID。'
                  : '模型列表来自当前 Provider。'}
          </span>
        </div>
        {ui.formProvider !== 'qoder' ? <div className="form-group">
          <label>执行速度</label>
          <select className="form-control" onChange={event => onFieldChange('formServiceTier', event.target.value)} value={ui.formServiceTier}>
            {serviceTierOptions(ui.formServiceTier).map(option => <option key={option.value || 'standard'} value={option.value}>{option.label}</option>)}
          </select>
          <span className="project-settings-hint">标准速度适合大多数项目。</span>
        </div> : null}
      </div>

      <div className="form-group">
        <label>执行权限与确认</label>
        <select className="form-control" onChange={event => onFieldChange('formExecutionPolicy', policyFromValue(event.target.value))} value={policyValue}>
          {policyOptions.map(option => (
            <option disabled={option.disabled} key={option.id} value={option.value} title={option.reason}>{option.label}{option.disabled ? '（当前 transport 不支持）' : ''}</option>
          ))}
        </select>
        <span className="project-settings-hint">隔离能力：{isolationLabel(ui.providerCatalog, ui.formProvider)}。低权限仍会启动；越权操作会被拒绝，需要确认的操作会暂停并通知你。</span>
        {ui.formExecutionPolicy.access !== 'unrestricted-host' || ui.formExecutionPolicy.approval !== 'unattended' ? (
          <div className="project-settings-permission-notice" role="status">任务可能等待审批或因当前权限不足而无法完成，但不会仅因选择低权限而拒绝启动。</div>
        ) : null}
      </div>
    </div>
  );
}

function AgentProfileManager({ profiles, loading, form, error, modelOptions, models, modelsError, modelsLoading, onFieldChange, onSubmit, onEdit, onReset, providerCatalog, providerOptions }) {
  const providerReady = providerOptions.some(option => option.value === form.provider);
  const profilePolicyOptions = executionPolicyPresets(providerCatalog, form.provider, form.execution_policy, true);
  const profilePolicyValue = form.execution_policy ? executionPolicyValue(form.execution_policy) : '';
  return (
    <div className="project-profile-manager">
      <div>
        <div className="project-profile-title">Profile 预设</div>
        <p className="project-profile-copy">给可复用的执行偏好起个名字。Profile 不会安装插件，也不会扩大项目权限。</p>
      </div>
      {error && <div className="project-profile-error">{error}</div>}
      <div className="project-profile-fields">
        <div className="form-group">
          <label>Profile 名称</label>
          <input className="form-control" placeholder="例如：前端日常开发" value={form.name} onChange={event => onFieldChange('name', event.target.value)} />
        </div>
        <div className="form-group">
          <label>默认指令（可选）</label>
          <textarea className="form-control" rows={3} placeholder="例如：优先运行前端测试，保持最小改动" value={form.default_instructions} onChange={event => onFieldChange('default_instructions', event.target.value)} />
        </div>
        <details className="project-profile-overrides">
          <summary>Profile 覆盖项（高级）</summary>
          <p>只有这个 Profile 需要覆盖项目默认值时才填写。</p>
          <div className="form-group">
            <label>Profile ID</label>
            <input className="form-control" placeholder="留空时根据名称自动生成" value={form.id} onChange={event => onFieldChange('id', event.target.value)} />
          </div>
          <div className="project-settings-grid project-profile-grid">
            <label className="form-group">执行引擎
              <select className="form-control" value={form.provider} onChange={event => onFieldChange('provider', event.target.value)}>
                {!providerReady && form.provider ? <option disabled value={form.provider}>{codeAgentLabel(form.provider, providerCatalog)}（不可用）</option> : null}
                {providerOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="form-group">默认模型
              {form.provider === 'qoder' || modelsError ? (
                <input className="form-control" list="profile-provider-model-suggestions" placeholder="Provider 默认，或手动填写 model ID" value={form.model} onChange={event => onFieldChange('model', event.target.value)} />
              ) : (
                <select className="form-control" disabled={modelsLoading} value={form.model} onChange={event => onFieldChange('model', event.target.value)}>
                  {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              )}
              <datalist id="profile-provider-model-suggestions">
                {modelOptions.filter(option => option.value).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </datalist>
            </label>
            <label className="form-group">推理深度
              <select className="form-control" value={form.reasoning_effort} onChange={event => onFieldChange('reasoning_effort', event.target.value)}>
                {profileEffortOptions(form, models).map(option => <option key={option.value || 'default'} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {form.provider !== 'qoder' ? <label className="form-group">执行速度
              <select className="form-control" value={form.service_tier} onChange={event => onFieldChange('service_tier', event.target.value)}>
                {serviceTierOptions(form.service_tier).map(option => <option key={option.value || 'standard'} value={option.value}>{option.label}</option>)}
              </select>
            </label> : null}
            <label className="form-group">执行权限与确认
              <select className="form-control" value={profilePolicyValue} onChange={event => onFieldChange('execution_policy', event.target.value ? policyFromValue(event.target.value) : null)}>
                {profilePolicyOptions.map(option => <option disabled={option.disabled} key={option.id} value={option.value}>{option.label}{option.disabled ? '（当前 transport 不支持）' : ''}</option>)}
              </select>
            </label>
          </div>
          <div className="project-settings-grid project-profile-grid">
            <label className="form-group">Skill 意图（可选）
              <input className="form-control" placeholder="多个值用逗号分隔" value={form.skill_intents} onChange={event => onFieldChange('skill_intents', event.target.value)} />
            </label>
            <label className="form-group">Plugin 意图（可选）
              <input className="form-control" placeholder="多个值用逗号分隔" value={form.plugin_intents} onChange={event => onFieldChange('plugin_intents', event.target.value)} />
            </label>
          </div>
        </details>
        <div className="project-profile-actions">
          <span>{loading ? '正在加载 Profile…' : `已有 ${profiles.length} 个 Profile`}</span>
          <div><button type="button" className="btn btn-secondary" onClick={onReset}>清空</button><button type="button" className="btn btn-secondary" onClick={onSubmit}>保存 Profile</button></div>
        </div>
      </div>
      {profiles.length > 0 && <div className="project-profile-list">{profiles.map(profile => <button key={profile.id} type="button" className="kanban-card-action-btn" onClick={() => onEdit(profile)}>{profile.name} · {profile.id}</button>)}</div>}
    </div>
  );
}

function profileEffortOptions(form, models = []) {
  const inherited = { value: '', label: '沿用默认值' };
  if (form.provider !== 'qoder') return [
    inherited,
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'xhigh', label: '极高' },
  ];
  const selected = models.find(model => (model?.id || model?.model) === form.model);
  const efforts = Array.isArray(selected?.supportedReasoningEfforts)
    ? selected.supportedReasoningEfforts.map(item => item?.reasoningEffort).filter(Boolean)
    : [];
  if (!selected?.verified || !efforts.length) {
    return form.reasoning_effort ? [inherited, { value: form.reasoning_effort, label: `${form.reasoning_effort}（未验证）` }] : [inherited];
  }
  return [inherited, ...efforts.map(value => ({ value, label: value }))];
}
