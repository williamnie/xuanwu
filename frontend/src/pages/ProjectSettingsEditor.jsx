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
import { PROVIDER_OPTIONS } from './sessions/sessionOptions.js';
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

function normalizeCodexModel(model) {
  return String(model || '').trim() || DEFAULT_CODEX_MODEL;
}

function buildCodexModelOptions(models, ...selectedValues) {
  const options = [];
  const seen = new Set();
  const pushOption = (value, label) => {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue || seen.has(normalizedValue)) return;
    seen.add(normalizedValue);
    options.push({ value: normalizedValue, label: String(label || normalizedValue).trim() || normalizedValue });
  };

  pushOption(DEFAULT_CODEX_MODEL, '系统默认模型');
  const liveModels = Array.isArray(models) ? models.filter(model => !model?.hidden) : [];
  liveModels.forEach(model => pushOption(model?.id || model?.model, model?.displayName || model?.name || model?.id || model?.model));
  selectedValues.forEach(value => {
    const normalizedValue = normalizeCodexModel(value);
    if (normalizedValue !== DEFAULT_CODEX_MODEL) pushOption(normalizedValue, normalizedValue);
  });
  return options;
}

function projectForm(project) {
  return {
    formAgentProfileId: project?.default_agent_profile_id || '',
    formApproval: project?.approval_policy || 'never',
    formCwd: project?.cwd || '',
    formModel: normalizeCodexModel(project?.model),
    formProvider: project?.provider || DEFAULT_PROVIDER,
    formProviderConfig: project?.provider_config_json || '{}',
    formSandbox: project?.sandbox || 'workspace-write',
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

  const loadCodexModels = useCallback(async () => {
    updateUi(draft => {
      draft.codexModelsLoading = true;
      draft.codexModelsError = '';
    });
    try {
      const result = await systemApi.getCodexModels();
      updateUi(draft => {
        draft.codexModels = Array.isArray(result?.data) ? result.data : [];
      });
    } catch (error) {
      updateUi(draft => {
        draft.codexModels = [];
        draft.codexModelsError = error.message || '读取 Codex 模型列表失败';
      });
    } finally {
      updateUi(draft => {
        draft.codexModelsLoading = false;
      });
    }
  }, [updateUi]);

  useEffect(() => {
    loadAgentProfiles();
    loadCodexModels();
  }, [loadAgentProfiles, loadCodexModels]);

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

  const setProfileFormField = (field, value) => {
    updateUi(draft => {
      draft.profileForm[field] = value;
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!ui.formCwd.trim()) {
      updateUi(draft => {
        draft.formError = '工作路径(CWD)不能为空';
      });
      return;
    }

    const payload = {
      name: projectNameFromPath(ui.formCwd),
      cwd: ui.formCwd,
      provider: ui.formProvider,
      provider_config_json: ui.formProviderConfig,
      model: normalizeCodexModel(ui.formModel),
      approval_policy: ui.formApproval,
      sandbox: ui.formSandbox,
      default_service_tier: ui.formServiceTier,
      default_agent_profile_id: ui.formAgentProfileId,
    };

    updateUi(draft => {
      draft.formError = '';
      draft.saving = true;
    });
    try {
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
    try {
      const exists = ui.profiles.some(profile => profile.id === payload.id);
      const saved = exists
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

  const modelOptions = buildCodexModelOptions(ui.codexModels, ui.formModel, ui.profileForm.model);
  const modal = layout === 'modal';

  return (
    <form className={modal ? 'project-config-modal-form' : 'project-settings-editor-form'} onSubmit={handleSubmit}>
      <div className={modal ? 'project-config-modal-body' : 'project-settings-editor-body'}>
        {ui.formError && <div className="project-settings-error" role="alert">{ui.formError}</div>}

        <div className="form-group">
          <label>项目绝对路径 (CWD) *</label>
          <input
            className="form-control"
            onChange={event => setFormField('formCwd', event.target.value)}
            placeholder="/Users/username/projects/project-name"
            required
            type="text"
            value={ui.formCwd}
          />
          <span className="project-settings-hint">
            展示名会自动使用路径最后一级：{ui.formCwd.trim() ? projectNameFromPath(ui.formCwd) : '—'}
          </span>
        </div>

        <div className="form-group">
          <label>Provider</label>
          <select className="form-control" onChange={event => setFormField('formProvider', event.target.value)} value={ui.formProvider}>
            {PROVIDER_OPTIONS.map(option => (
              <option disabled={!option.enabled} key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="project-settings-hint">capability 摘要会随项目 API 返回；execution-only provider 不会进入 Sessions。</span>
        </div>

        <div className="project-settings-grid">
          <div className="form-group">
            <label>Codex 执行模型</label>
            {ui.codexModelsError ? (
              <input className="form-control" onChange={event => setFormField('formModel', event.target.value)} placeholder="模型 API 失败，请手动填写 model ID" value={ui.formModel} />
            ) : (
              <select className="form-control" disabled={ui.codexModelsLoading} onChange={event => setFormField('formModel', event.target.value)} value={ui.formModel}>
                {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            )}
            <span className="project-settings-hint">
              {ui.codexModelsLoading
                ? '正在读取 Codex 模型列表…'
                : ui.codexModelsError
                  ? `远端 model API 读取失败，已启用手填：${ui.codexModelsError}`
                  : '模型列表来自当前 Codex provider。'}
            </span>
          </div>
          <div className="form-group">
            <label>默认执行速度</label>
            <select className="form-control" onChange={event => setFormField('formServiceTier', event.target.value)} value={ui.formServiceTier}>
              {serviceTierOptions(ui.formServiceTier).map(option => <option key={option.value || 'standard'} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        </div>

        <div className="project-settings-grid">
          <div className="form-group">
            <label>审批策略 (Approval)</label>
            <select className="form-control" onChange={event => setFormField('formApproval', event.target.value)} value={ui.formApproval}>
              <option value="never">从不审核 (自动运行)</option>
              <option value="always">每次执行必审</option>
              <option value="danger-only">敏感操作时审核</option>
            </select>
          </div>
          <div className="form-group">
            <label>沙箱策略 (Sandbox)</label>
            <select className="form-control" onChange={event => setFormField('formSandbox', event.target.value)} value={ui.formSandbox}>
              <option value="workspace-write">仅允许修改当前项目目录 (推荐)</option>
              <option value="danger-full-access">全系统读写访问 (危险)</option>
              <option value="read-only">严格只读</option>
            </select>
          </div>
        </div>

        <div className="form-group">
          <label>默认 Agent Profile v0</label>
          <select className="form-control" onChange={event => setFormField('formAgentProfileId', event.target.value)} value={ui.formAgentProfileId}>
            <option value="">不使用 Profile（沿用上方项目参数）</option>
            {ui.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.id}</option>)}
          </select>
          <span className="project-settings-hint">Profile 会在 issue prompt 中注入默认 instructions 与 skill/plugin intent；不会安装插件或放大权限。</span>
        </div>

        <AgentProfileManager
          error={ui.profileError}
          form={ui.profileForm}
          loading={ui.profilesLoading}
          modelOptions={modelOptions}
          modelsError={ui.codexModelsError}
          modelsLoading={ui.codexModelsLoading}
          onEdit={profile => updateUi(draft => { draft.profileForm = normalizeAgentProfileForm(profile); draft.profileError = ''; })}
          onFieldChange={setProfileFormField}
          onReset={() => updateUi(draft => { draft.profileForm = emptyAgentProfileForm(); draft.profileError = ''; })}
          onSubmit={handleProfileSubmit}
          profiles={ui.profiles}
        />
      </div>

      <div className={modal ? 'project-config-modal-footer' : 'project-settings-editor-footer'}>
        {onCancel && <button className="btn btn-secondary" disabled={ui.saving} onClick={onCancel} type="button">取消</button>}
        <button className="btn btn-primary" disabled={ui.saving} type="submit">
          {ui.saving ? '正在保存…' : mode === 'create' ? '创建并接管' : '保存项目设置'}
        </button>
      </div>
    </form>
  );
}

function AgentProfileManager({ profiles, loading, form, error, modelOptions, modelsError, modelsLoading, onFieldChange, onSubmit, onEdit, onReset }) {
  return (
    <div className="project-profile-manager">
      <div>
        <div className="project-profile-title">Agent Profile v0</div>
        <p className="project-profile-copy">仅保存 provider/model/权限 preset、默认 instructions 与 skill/plugin intent；不安装插件、不提升权限。</p>
      </div>
      {error && <div className="project-profile-error">{error}</div>}
      <div className="project-profile-fields">
        <div className="project-settings-grid project-profile-grid">
          <select className="form-control" value={form.provider} onChange={event => onFieldChange('provider', event.target.value)}>
            {PROVIDER_OPTIONS.map(option => <option key={option.value} value={option.value} disabled={!option.enabled}>{option.label}</option>)}
          </select>
          <input className="form-control" placeholder="Profile ID（可留空自动生成）" value={form.id} onChange={event => onFieldChange('id', event.target.value)} />
          <input className="form-control" placeholder="Profile 名称" value={form.name} onChange={event => onFieldChange('name', event.target.value)} />
          {modelsError ? (
            <input className="form-control" placeholder="模型 API 失败，请手动填写 model ID" value={form.model} onChange={event => onFieldChange('model', event.target.value)} />
          ) : (
            <select className="form-control" disabled={modelsLoading} value={form.model} onChange={event => onFieldChange('model', event.target.value)}>
              {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          )}
          <select className="form-control" value={form.reasoning_effort} onChange={event => onFieldChange('reasoning_effort', event.target.value)}>
            <option value="">默认 effort</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option>
          </select>
          <select className="form-control" value={form.service_tier} onChange={event => onFieldChange('service_tier', event.target.value)}>
            {serviceTierOptions(form.service_tier).map(option => <option key={option.value || 'standard'} value={option.value}>速度：{option.label}</option>)}
          </select>
        </div>
        <div className="project-settings-grid project-profile-grid">
          <select className="form-control" value={form.approval_policy} onChange={event => onFieldChange('approval_policy', event.target.value)}>
            <option value="">沿用项目 approval</option><option value="never">never</option><option value="always">always</option><option value="danger-only">danger-only</option>
          </select>
          <select className="form-control" value={form.sandbox} onChange={event => onFieldChange('sandbox', event.target.value)}>
            <option value="">沿用项目 sandbox</option><option value="workspace-write">workspace-write</option><option value="read-only">read-only</option><option value="danger-full-access">danger-full-access</option>
          </select>
        </div>
        <textarea className="form-control" rows={3} placeholder="默认 instructions" value={form.default_instructions} onChange={event => onFieldChange('default_instructions', event.target.value)} />
        <div className="project-settings-grid project-profile-grid">
          <input className="form-control" placeholder="skill intents，逗号分隔" value={form.skill_intents} onChange={event => onFieldChange('skill_intents', event.target.value)} />
          <input className="form-control" placeholder="plugin intents，逗号分隔" value={form.plugin_intents} onChange={event => onFieldChange('plugin_intents', event.target.value)} />
        </div>
        <div className="project-profile-actions">
          <span>{loading ? '加载 profiles...' : `已有 ${profiles.length} 个 profile`}</span>
          <div><button type="button" className="btn btn-secondary" onClick={onReset}>清空</button><button type="button" className="btn btn-secondary" onClick={onSubmit}>保存 Profile</button></div>
        </div>
      </div>
      {profiles.length > 0 && <div className="project-profile-list">{profiles.map(profile => <button key={profile.id} type="button" className="kanban-card-action-btn" onClick={() => onEdit(profile)}>{profile.name} · {profile.id}</button>)}</div>}
    </div>
  );
}
