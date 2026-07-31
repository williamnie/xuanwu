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
    loadCodexModels();
    if (mode === 'edit') loadAgentProfiles();
  }, [loadAgentProfiles, loadCodexModels, mode]);

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
        draft.formError = '项目路径不能为空';
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
            <p>不确定时无需修改。默认使用 Codex、系统默认模型、标准速度，并仅允许写入当前项目目录。</p>
            <ProjectRuntimeFields modelOptions={modelOptions} onFieldChange={setFormField} ui={ui} />
          </details>
        ) : (
          <>
            <ProjectRuntimeFields modelOptions={modelOptions} onFieldChange={setFormField} ui={ui} />
            <details className="project-settings-advanced project-profile-settings">
              <summary>Agent Profile（可选）</summary>
              <p>只有需要复用一组模型、权限或指令预设时才配置；普通项目可以完全忽略。</p>
              <div className="form-group">
                <label>项目默认 Profile</label>
                <select className="form-control" onChange={event => setFormField('formAgentProfileId', event.target.value)} value={ui.formAgentProfileId}>
                  <option value="">不使用 Profile（沿用项目运行配置）</option>
                  {ui.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.id}</option>)}
                </select>
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
            </details>
          </>
        )}
      </div>

      <div className={modal ? 'project-config-modal-footer' : 'project-settings-editor-footer'}>
        {onCancel && <button className="btn btn-secondary" disabled={ui.saving} onClick={onCancel} type="button">取消</button>}
        <button className="btn btn-primary" disabled={ui.saving} type="submit">
          {ui.saving ? '正在保存…' : mode === 'create' ? '添加并接管' : '保存项目设置'}
        </button>
      </div>
    </form>
  );
}

function ProjectRuntimeFields({ modelOptions, onFieldChange, ui }) {
  return (
    <div className="project-runtime-fields">
      <div className="form-group">
        <label>执行引擎</label>
        <select className="form-control" onChange={event => onFieldChange('formProvider', event.target.value)} value={ui.formProvider}>
          {PROVIDER_OPTIONS.map(option => (
            <option disabled={!option.enabled} key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <span className="project-settings-hint">决定由哪个执行器处理项目；通常保持 Codex。</span>
      </div>

      <div className="project-settings-grid">
        <div className="form-group">
          <label>默认模型</label>
          {ui.codexModelsError ? (
            <input className="form-control" onChange={event => onFieldChange('formModel', event.target.value)} placeholder="模型 API 失败，请手动填写 model ID" value={ui.formModel} />
          ) : (
            <select className="form-control" disabled={ui.codexModelsLoading} onChange={event => onFieldChange('formModel', event.target.value)} value={ui.formModel}>
              {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          )}
          <span className="project-settings-hint">
            {ui.codexModelsLoading
              ? '正在读取 Codex 模型列表…'
              : ui.codexModelsError
                ? `远端 model API 读取失败，已启用手填：${ui.codexModelsError}`
                : '系统默认会跟随当前 Codex 配置。'}
          </span>
        </div>
        <div className="form-group">
          <label>执行速度</label>
          <select className="form-control" onChange={event => onFieldChange('formServiceTier', event.target.value)} value={ui.formServiceTier}>
            {serviceTierOptions(ui.formServiceTier).map(option => <option key={option.value || 'standard'} value={option.value}>{option.label}</option>)}
          </select>
          <span className="project-settings-hint">标准速度适合大多数项目。</span>
        </div>
      </div>

      <div className="project-settings-grid">
        <div className="form-group">
          <label>操作确认</label>
          <select className="form-control" onChange={event => onFieldChange('formApproval', event.target.value)} value={ui.formApproval}>
            <option value="never">自动运行，不逐次确认</option>
            <option value="danger-only">敏感操作时确认</option>
            <option value="always">每次执行都确认</option>
          </select>
          <span className="project-settings-hint">控制执行过程中何时需要人工确认。</span>
        </div>
        <div className="form-group">
          <label>执行权限范围</label>
          <select className="form-control" onChange={event => onFieldChange('formSandbox', event.target.value)} value={ui.formSandbox}>
            <option value="workspace-write">仅当前项目可写（推荐）</option>
            <option value="read-only">只读</option>
            <option value="danger-full-access">允许访问整个系统</option>
          </select>
          <span className="project-settings-hint">同时影响执行器的文件、进程和本机网络访问边界。</span>
          {ui.formSandbox !== 'danger-full-access' && (
            <div className="project-settings-permission-notice" role="status">
              {ui.formSandbox === 'read-only'
                ? '只读模式不能修改项目文件，也可能阻止需要写入缓存或构建产物的任务。'
                : '如果任务需要访问项目目录外文件，或调用 127.0.0.1 / localhost 服务，执行器可能被沙箱拦截；请改用“允许访问整个系统”或收窄任务边界。'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentProfileManager({ profiles, loading, form, error, modelOptions, modelsError, modelsLoading, onFieldChange, onSubmit, onEdit, onReset }) {
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
                {PROVIDER_OPTIONS.map(option => <option key={option.value} value={option.value} disabled={!option.enabled}>{option.label}</option>)}
              </select>
            </label>
            <label className="form-group">默认模型
              {modelsError ? (
                <input className="form-control" placeholder="模型 API 失败，请手动填写 model ID" value={form.model} onChange={event => onFieldChange('model', event.target.value)} />
              ) : (
                <select className="form-control" disabled={modelsLoading} value={form.model} onChange={event => onFieldChange('model', event.target.value)}>
                  {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              )}
            </label>
            <label className="form-group">推理深度
              <select className="form-control" value={form.reasoning_effort} onChange={event => onFieldChange('reasoning_effort', event.target.value)}>
                <option value="">沿用默认值</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option>
              </select>
            </label>
            <label className="form-group">执行速度
              <select className="form-control" value={form.service_tier} onChange={event => onFieldChange('service_tier', event.target.value)}>
                {serviceTierOptions(form.service_tier).map(option => <option key={option.value || 'standard'} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="form-group">操作确认
              <select className="form-control" value={form.approval_policy} onChange={event => onFieldChange('approval_policy', event.target.value)}>
                <option value="">沿用项目设置</option><option value="never">自动运行</option><option value="danger-only">敏感操作时确认</option><option value="always">每次都确认</option>
              </select>
            </label>
            <label className="form-group">文件访问范围
              <select className="form-control" value={form.sandbox} onChange={event => onFieldChange('sandbox', event.target.value)}>
                <option value="">沿用项目设置</option><option value="workspace-write">仅当前项目可写</option><option value="read-only">只读</option><option value="danger-full-access">整个系统</option>
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
