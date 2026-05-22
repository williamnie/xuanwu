export const REASONING_EFFORT_OPTIONS = [
  { value: '', label: '默认', shortLabel: '默认' },
  { value: 'minimal', label: 'Minimal', shortLabel: 'Min' },
  { value: 'low', label: '低', shortLabel: '低' },
  { value: 'medium', label: '中', shortLabel: '中' },
  { value: 'high', label: '高', shortLabel: '高' },
  { value: 'xhigh', label: '超高', shortLabel: '超高' },
];

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

export function modelValueFromProject(project) {
  if (!project || !project.model || project.model === 'codex-default') {
    return '';
  }
  return project.model;
}

export function defaultSessionSettings(project) {
  return {
    model: modelValueFromProject(project),
    reasoningEffort: '',
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
