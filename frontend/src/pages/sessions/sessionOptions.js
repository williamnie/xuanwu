export const REASONING_EFFORT_OPTIONS = [
  { value: '', label: '默认', shortLabel: '默认' },
  { value: 'minimal', label: 'Minimal', shortLabel: 'Min' },
  { value: 'low', label: '低', shortLabel: '低' },
  { value: 'medium', label: '中', shortLabel: '中' },
  { value: 'high', label: '高', shortLabel: '高' },
  { value: 'xhigh', label: '超高', shortLabel: '超高' },
];

export const SERVICE_TIER_STANDARD = '';
export const SERVICE_TIER_FAST = 'priority';

export const APPROVAL_OPTIONS = [
  { value: 'never', label: '不询问授权', shortLabel: '不询问' },
  { value: 'danger-only', label: '敏感操作确认', shortLabel: '敏感确认' },
  { value: 'always', label: '每次执行必审', shortLabel: '必审' },
];

export const SANDBOX_OPTIONS = [
  { value: 'workspace-write', label: 'Workspace write' },
  { value: 'read-only', label: 'Read only' },
  { value: 'danger-full-access', label: 'Danger full access' },
];

export const PROVIDER_OPTIONS = [
  { value: 'codex', label: 'Codex', enabled: true },
  { value: 'fake-execution-only', label: 'Fake execution-only', enabled: true },
  { value: 'claude', label: 'Claude Agent SDK', enabled: true },
];

/**
 * P6：从后端 /api/providers catalog 派生可提交 option（唯一权威）。
 * 未注册/planned Provider（如 opencode/kimicode）不进入；not-ready 可见但 disabled。
 */
export function providerOptionsFromCatalog(catalog) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => ({
      value: entry.id,
      label: entry.label || entry.id,
      enabled: entry.submittable !== false,
      state: entry.state,
    }));
}

export const CAPABILITY_LABELS = {
  issue_execution: 'Issue 执行',
  sessions: 'Sessions',
  resume_session: '恢复会话',
  interrupt: '中断',
  approvals: '审批',
  model_list: '模型列表',
  // transcript_export 非通用 capability：由 Provider manifest nativeActions 提供（P6）
};

export function providerValue(project) {
  return project?.provider || '';
}

/**
 * P6：单一 label helper——catalog 优先，静态回退（旧 projection 兼容窗口）。
 */
export function providerLabel(value, catalog) {
  const entry = (Array.isArray(catalog) ? catalog : []).find((item) => item?.id === value);
  if (entry?.label) return entry.label;
  const option = PROVIDER_OPTIONS.find((item) => item.value === value);
  return option?.label || value || '未配置';
}

export function providerCapabilities(project) {
  return Array.isArray(project?.provider_capabilities) ? project.provider_capabilities : [];
}

export function providerSupports(project, capability) {
  return providerCapabilities(project).includes(capability);
}

export function capabilitySummary(project) {
  const capabilities = providerCapabilities(project);
  if (!capabilities.length) return '暂无 capability 声明';
  return capabilities.map((item) => CAPABILITY_LABELS[item] || item).join(' / ');
}

export function modelValueFromProject(project) {
  if (!project || !project.model || project.model === 'codex-default') {
    return '';
  }
  return project.model;
}

export function defaultSessionSettings(project) {
  return {
    provider: providerValue(project),
    model: modelValueFromProject(project),
    reasoningEffort: '',
    serviceTier: SERVICE_TIER_STANDARD,
    approvalPolicy: project?.approval_policy || 'never',
    sandbox: project?.sandbox || 'workspace-write',
  };
}

export function defaultMessageSettings(project) {
  return defaultSessionSettings(project);
}

export function modelLabel(model) {
  return model?.displayName || model?.id || model?.model || 'Unknown model';
}

export function supportedEffortValues(model) {
  const efforts = model?.supportedReasoningEfforts || [];
  return efforts.map((item) => item.reasoningEffort).filter(Boolean);
}

export function serviceTierOptions(model, selectedValue = SERVICE_TIER_STANDARD) {
  const tiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : [];
  const options = [{ value: SERVICE_TIER_STANDARD, label: '标准', shortLabel: '标准' }];
  for (const tier of tiers) {
    const value = tier?.id || '';
    if (!value) continue;
    options.push({
      value,
      label: tier.name || value,
      shortLabel: tier.name === 'Fast' ? '快速' : tier.name || value,
      description: tier.description || '',
    });
  }
  if (selectedValue && !options.some((option) => option.value === selectedValue)) {
    options.push({ value: selectedValue, label: selectedValue, shortLabel: selectedValue });
  }
  return options;
}
