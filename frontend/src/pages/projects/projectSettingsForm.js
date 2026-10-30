import { normalizeProviderModel } from '../projectModelOptions.js';
import { projectExecutionPolicy } from '../../utils/executionPolicy.js';

const DEFAULT_PROJECT_NAME = 'project';
export const DEFAULT_PROVIDER = 'codex';

export function projectNameFromPath(cwd = '') {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || DEFAULT_PROJECT_NAME;
}

export function projectForm(project) {
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

export function initialEditorState(project) {
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
