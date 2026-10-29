import AgentProfileSelectOptions from '../components/AgentProfileSelectOptions.jsx';
import { useProjectPresetCatalog } from './useProjectPresetCatalog.js';
import { useCallback, useEffect, useRef } from 'react';
import { useI18n } from '../i18n/context.js';
import { buildProviderModelOptions, normalizeProviderModel } from './projectModelOptions.js';
import { useImmer } from 'use-immer';
import { systemApi } from '../api/system.js';
import { projectsApi } from '../api/projects.js';
import { nodesApi } from '../api/nodes.js';
import { nodeReadyProviders, nodeStatus } from './remoteNodesModel.js';
import { message } from '../store/toastStore.js';
import { serviceTierOptions } from '../utils/serviceTier.js';
import { availableAgentProfiles, codeAgentLabel } from '../utils/codeAgents.js';
import { providerOptionsFromCatalog } from './sessions/sessionOptions.js';
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
const DEFAULT_PROVIDER = 'codex';

function projectNameFromPath(cwd = '') {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || DEFAULT_PROJECT_NAME;
}

function projectForm(project) {
  const executionPolicy = projectExecutionPolicy(project);
  return {
    formAgentProfileId: project?.default_agent_profile_id || '',
    formApproval: project?.approval_policy || 'never',
    // 远程项目的 cwd 是 node:// 形式，表单里只编辑节点上的路径。
    formCwd: project?.node_id ? project.node_path || '' : project?.cwd || '',
    formNodeId: project?.node_id || '',
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
    nodes: [],
    profileError: '',
    profiles: [],
    profilesLoading: false,
    providerCatalog: [],
    providerCatalogError: '',
    providerCatalogLoading: true,
    saving: false,
  };
}

export default function ProjectSettingsEditor({ layout = 'inline', mode = 'edit', onCancel, onSaved, project = null }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const [ui, updateUi] = useImmer(() => initialEditorState(project));
  const projectID = project?.id || '';
  const modelRequest = useRef(0);
  const selectedNode = ui.nodes.find(node => node.id === ui.formNodeId) || null;
  const remote = ui.formNodeId !== '';
  const presetCatalog = useProjectPresetCatalog(mode === 'edit' ? ui.formNodeId : '', ui.providerCatalog);

  useEffect(() => {
    let cancelled = false;
    nodesApi.listNodes()
      .then(result => {
        if (!cancelled) updateUi(draft => { draft.nodes = Array.isArray(result?.nodes) ? result.nodes : []; });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [updateUi]);

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
        draft.profileError = error.message || '读取执行预设失败';
      });
    } finally {
      updateUi(draft => {
        draft.profilesLoading = false;
      });
    }
  }, [updateUi]);

  // nodeId 非空时读取该节点上编程工具的模型列表。
  const loadProviderModels = useCallback(async (provider = DEFAULT_PROVIDER, nodeId = '') => {
    const request = ++modelRequest.current;
    updateUi(draft => {
      draft.codexModels = [];
      draft.codexModelsLoading = true;
      draft.codexModelsError = '';
    });
    try {
      const result = await systemApi.getProviderModels(provider, { nodeId });
      if (request !== modelRequest.current) return;
      updateUi(draft => {
        const data = Array.isArray(result?.data?.data) ? result.data.data : result?.data;
        draft.codexModels = Array.isArray(data) ? data : [];
      });
    } catch (error) {
      if (request !== modelRequest.current) return;
      updateUi(draft => {
        draft.codexModels = [];
        draft.codexModelsError = error.message || '读取编程工具模型列表失败';
      });
    } finally {
      if (request === modelRequest.current) updateUi(draft => {
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
      if (selectedProvider) await loadProviderModels(selectedProvider, project?.node_id || '');
    } catch (error) {
      updateUi(draft => {
        draft.providerCatalog = [];
        draft.providerCatalogError = error.message || '读取编程工具列表失败';
        draft.providerCatalogLoading = false;
      });
    }
  }, [loadProviderModels, mode, project?.node_id, project?.provider, updateUi]);

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
    loadProviderModels(value, ui.formNodeId);
  };

  const setProjectNode = (nodeId) => {
    const node = ui.nodes.find(item => item.id === nodeId) || null;
    const provider = node ? (nodeReadyProviders(node)[0] || '') : (providerOptionsFromCatalog(ui.providerCatalog)[0]?.value || DEFAULT_PROVIDER);
    updateUi(draft => {
      draft.formNodeId = nodeId;
      draft.formProvider = provider;
      draft.formModel = normalizeProviderModel(provider, '');
      draft.formServiceTier = '';
    });
    loadProviderModels(provider, node ? nodeId : '');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (presetCatalog.loading || presetCatalog.error) return;
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
      ...(remote ? { node_id: ui.formNodeId } : {}),
    };

    updateUi(draft => {
      draft.formError = '';
      draft.saving = true;
    });
    try {
      // 远程项目的编程工具在节点上，执行策略在运行时由中心按内置能力解析。
      if (!remote) {
        const preview = await systemApi.resolveProviderExecutionPolicy(ui.formProvider, {
          project_id: projectID,
          policy: executionPolicyPayload(ui.formExecutionPolicy),
        });
        if (preview?.supported === false) throw new Error(preview.reason || '当前编程工具不支持所选执行策略');
      }
      // 由后端按完整位置分配 ID，避免本机与远程节点上的同名项目冲突。
      const pathCheck = mode === 'create'
        ? await projectsApi.checkPath(payload.cwd, { nodeId: ui.formNodeId })
        : null;
      if (pathCheck && !pathCheck.directory) throw new Error(remote ? '节点上不存在该文件夹' : '本地不存在该文件夹');
      const saved = mode === 'create'
        ? await projectsApi.createProject({ id: pathCheck.suggested_id, ...payload })
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

  const discoveredProviderOptions = providerOptionsFromCatalog(ui.providerCatalog);
  const providerOptions = remote
    ? nodeReadyProviders(selectedNode).map(id => ({ value: id, label: codeAgentLabel(id, ui.providerCatalog) }))
    : discoveredProviderOptions;
  const availableProfiles = availableAgentProfiles(ui.profiles, presetCatalog.catalog);
  const modelOptions = buildProviderModelOptions(ui.formProvider, ui.codexModels, [ui.formModel], language);
  const modal = layout === 'modal';
  const providerReady = providerOptions.some(option => option.value === ui.formProvider);
  const historicalProviderPreserved = mode === 'edit' && ui.formProvider === (project?.provider || DEFAULT_PROVIDER);

  return (
    <form className={modal ? 'project-config-modal-form' : 'project-settings-editor-form'} onSubmit={handleSubmit}>
      <div className={modal ? 'project-config-modal-body' : 'project-settings-editor-body'}>
        {ui.formError && <div className="project-settings-error" role="alert">{ui.formError}</div>}

        {ui.nodes.length > 0 || remote ? (
          <div className="form-group">
            <label><span className="ds-mono-label">运行位置</span></label>
            <select
              aria-label="运行位置"
              className="form-control"
              disabled={mode === 'edit'}
              onChange={event => setProjectNode(event.target.value)}
              value={ui.formNodeId}
            >
              <option value="">本机（玄武所在服务器）</option>
              {ui.nodes.map(node => (
                <option key={node.id} value={node.id}>{node.name}（{nodeStatus(node).label}）</option>
              ))}
              {remote && !selectedNode ? <option value={ui.formNodeId}>{ui.formNodeId}（读取中）</option> : null}
            </select>
            <span className="project-settings-hint">
              {mode === 'edit'
                ? '项目创建后不能更换运行位置。'
                : remote
                  ? '任务会在该节点上执行。远程项目暂不支持 Git 验收与交付。'
                  : '选择远程节点后，任务在那台机器上执行。'}
            </span>
          </div>
        ) : null}

        <div className="form-group">
          <label><span className="ds-mono-label">项目路径 *</span></label>
          <input
            autoFocus={mode === 'create'}
            className="form-control"
            onChange={event => setFormField('formCwd', event.target.value)}
            placeholder={remote ? '节点上的绝对路径，例如 /home/me/code/project' : '/Users/username/projects/project-name'}
            required
            type="text"
            value={ui.formCwd}
          />
          <span className="project-settings-hint">
            {remote ? '填写节点上项目根目录的绝对路径，需位于节点 --root 允许的目录内。' : '填写项目根目录的绝对路径。'}项目名称会自动识别为：{ui.formCwd.trim() ? projectNameFromPath(ui.formCwd) : '—'}
          </span>
        </div>

        {mode === 'create' ? (
          <details className="project-settings-advanced">
            <summary>高级运行配置（可选）</summary>
            <p>不确定时无需修改。默认使用无人值守开发策略，允许当前编程工具使用本机开发能力且不逐次等待确认。</p>
            <ProjectRuntimeFields modelOptions={modelOptions} onFieldChange={setProjectRuntimeField} providerOptions={providerOptions} ui={ui} />
          </details>
        ) : (
          <>
            <ProjectRuntimeFields modelOptions={modelOptions} onFieldChange={setProjectRuntimeField} providerOptions={providerOptions} ui={ui} />
            <label className="form-group">
              <span className="ds-mono-label">{english ? 'Execution preset' : '执行预设'}</span>
              <select className="form-control" value={ui.formAgentProfileId}
                disabled={ui.saving || ui.profilesLoading || presetCatalog.loading || Boolean(presetCatalog.error)}
                onChange={event => setFormField('formAgentProfileId', event.target.value)}>
                <option value="">{english ? 'Use project defaults' : '沿用项目设置'}</option>
                <AgentProfileSelectOptions catalog={presetCatalog.catalog} profiles={ui.profiles} selectedProfileID={ui.formAgentProfileId} />
              </select>
            </label>
            {presetCatalog.error ? <p className="project-settings-error" role="alert">{presetCatalog.error}</p> : null}
            <p className="project-settings-hint">
              {english ? 'Execution preset' : '执行预设'}：{ui.profiles.find(profile => profile.id === ui.formAgentProfileId)?.name || (ui.formAgentProfileId === project?.default_agent_profile_id ? project?.default_agent_profile?.name : '') || ui.formAgentProfileId || (english ? 'Project defaults' : '沿用项目设置')} · {' '}
              <a href="#/settings?section=advanced:presets" onClick={onCancel}>{english ? 'Edit in Advanced → Execution presets' : '在 高级 → 执行预设 中修改'}</a>
              {ui.profileError ? <span role="alert">{ui.profileError}</span> : null}
            </p>
          </>
        )}
      </div>

      <div className={modal ? 'project-config-modal-footer' : 'project-settings-editor-footer'}>
        {onCancel && <button className="btn btn-secondary" disabled={ui.saving} onClick={onCancel} type="button">取消</button>}
        <button className="btn btn-primary" disabled={ui.saving || ui.providerCatalogLoading || presetCatalog.loading || Boolean(presetCatalog.error) || (!providerReady && !historicalProviderPreserved)} type="submit">
          {ui.saving ? '正在保存…' : mode === 'create' ? '添加并接管' : '保存项目设置'}
        </button>
      </div>
    </form>
  );
}

function ProjectRuntimeFields({ modelOptions, onFieldChange, providerOptions, ui }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const providerReady = providerOptions.some(option => option.value === ui.formProvider);
  const providerSelectDisabled = ui.providerCatalogLoading || Boolean(ui.providerCatalogError) || providerOptions.length === 0;
  const policyOptions = executionPolicyPresets(ui.providerCatalog, ui.formProvider, ui.formExecutionPolicy);
  const policyValue = executionPolicyValue(ui.formExecutionPolicy);

  return (
    <div className="project-runtime-fields">
      <div className="form-group">
        <label><span className="ds-mono-label">{english ? 'Coding tool' : '编程工具'}</span></label>
        <select
          aria-busy={ui.providerCatalogLoading}
          className={`form-control${ui.providerCatalogLoading ? ' project-settings-control-loading' : ''}`}
          disabled={providerSelectDisabled}
          onChange={event => onFieldChange('formProvider', event.target.value)}
          value={ui.formProvider}
        >
          {ui.providerCatalogLoading && <option value="">正在读取可用编程工具…</option>}
          {!ui.providerCatalogLoading && ui.providerCatalogError && <option value="">编程工具加载失败</option>}
          {!ui.providerCatalogLoading && !ui.providerCatalogError && providerOptions.length === 0 && <option value="">暂无可用编程工具</option>}
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
              ? `读取编程工具失败：${ui.providerCatalogError}`
              : !providerReady
                ? '项目原编程工具当前不可用，请从可用列表中重新选择。'
                : '决定由哪个执行器处理项目；通常保持 Codex。'}
        </span>
      </div>

      <div className="form-group">
        <label><span className="ds-mono-label">{english ? 'Default model' : '默认模型'}</span></label>
        <select aria-label={english ? 'Default model' : '默认模型'} className="form-control" disabled={ui.codexModelsLoading} onChange={event => onFieldChange('formModel', event.target.value)} value={ui.formModel}>
          {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span className="project-settings-hint">
          {ui.codexModelsLoading
            ? (english ? 'Loading coding tool models…' : '正在读取编程工具模型列表…')
            : ui.codexModelsError
              ? (english ? `Model list unavailable; current value preserved: ${ui.codexModelsError}` : `模型列表读取失败，已保留当前值：${ui.codexModelsError}`)
              : ui.formProvider === 'qoder' && ui.codexModels.some(model => model?.verified === false)
                ? (english ? 'Model discovery unavailable; suggestions are unverified and the current value is preserved.' : 'Qoder 账号发现不可用；候选仅是静态建议，已保留当前自定义值。')
                : (english ? 'Models come from the selected coding tool.' : '模型列表来自当前编程工具。')}
        </span>
      </div>
      {ui.formProvider !== 'qoder' ? (
        <details className="project-settings-advanced">
          <summary>{english ? 'More options' : '更多选项'}</summary>
          <div className="project-runtime-fields">
            <div className="form-group">
              <label><span className="ds-mono-label">{english ? 'Execution speed' : '执行速度'}</span></label>
              <select className="form-control" onChange={event => onFieldChange('formServiceTier', event.target.value)} value={ui.formServiceTier}>
                {serviceTierOptions(ui.formServiceTier).map(option => <option key={option.value || 'standard'} value={option.value}>{english ? ({ '': 'Standard', priority: 'Fast' }[option.value] || option.label) : option.label}</option>)}
              </select>
              <span className="project-settings-hint">{english ? 'Standard speed suits most projects.' : '标准速度适合大多数项目。'}</span>
            </div>
          </div>
        </details>
      ) : null}

      <div className="form-group">
        <label><span className="ds-mono-label">执行权限与确认</span></label>
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
