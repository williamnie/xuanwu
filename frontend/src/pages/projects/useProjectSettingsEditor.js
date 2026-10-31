import { DEFAULT_PROVIDER, initialEditorState, projectForm, projectNameFromPath } from './projectSettingsForm.js';
import { useProjectPresetCatalog } from '../useProjectPresetCatalog.js';
import { useCallback, useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/context.js';
import { buildProviderModelOptions, normalizeProviderModel } from '../projectModelOptions.js';
import { useImmer } from 'use-immer';
import { systemApi } from '../../api/system.js';
import { projectsApi } from '../../api/projects.js';
import { nodesApi } from '../../api/nodes.js';
import { nodeReadyProviders } from '../remoteNodesModel.js';
import { message } from '../../store/toastStore.js';
import { availableAgentProfiles, codeAgentLabel } from '../../utils/codeAgents.js';
import { providerOptionsFromCatalog } from '../sessions/sessionOptions.js';
import { executionPolicyPayload } from '../../utils/executionPolicy.js';

export default function useProjectSettingsEditor({ mode, project, onSaved }) {
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
  const providerReady = providerOptions.some(option => option.value === ui.formProvider);
  const historicalProviderPreserved = mode === 'edit' && ui.formProvider === (project?.provider || DEFAULT_PROVIDER);
  return { ui, english, remote, selectedNode, presetCatalog, modelOptions, providerOptions, setFormField, setProjectNode, setProjectRuntimeField, handleSubmit, providerReady, historicalProviderPreserved };
}
