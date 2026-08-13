export const EXECUTION_POLICY_CONTRACT = 'xw.execution-policy.v1';

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  contract: EXECUTION_POLICY_CONTRACT,
  access: 'unrestricted-host',
  approval: 'unattended',
});

export const EXECUTION_POLICY_PRESETS = Object.freeze([
  { id: 'unattended-development', label: '无人值守开发（高权限）', access: 'unrestricted-host', approval: 'unattended', tone: 'danger' },
  { id: 'controlled-development', label: '受控开发', access: 'provider-native-development', approval: 'ask-sensitive', tone: 'default' },
  { id: 'confirm-every-side-effect', label: '每次副作用都确认', access: 'unrestricted-host', approval: 'ask-every-side-effect', tone: 'default' },
  { id: 'read-only', label: '只读检查', access: 'read-only', approval: 'unattended', tone: 'default' },
]);

export function normalizeExecutionPolicy(value, fallback = DEFAULT_EXECUTION_POLICY) {
  const policy = parsePolicy(value);
  if (!policy) return { ...fallback };
  return policy;
}

export function projectExecutionPolicy(project) {
  const explicit = parsePolicy(project?.execution_policy);
  if (explicit) return explicit;
  if (project?.sandbox || project?.approval_policy) return legacyExecutionPolicy(project?.sandbox, project?.approval_policy);
  return { ...DEFAULT_EXECUTION_POLICY };
}

export function profileExecutionPolicy(profile) {
  const raw = parsePolicy(profile?.execution_policy);
  if (raw) return raw;
  if (!profile?.sandbox && !profile?.approval_policy) return null;
  return legacyExecutionPolicy(profile?.sandbox, profile?.approval_policy);
}

export function settingsExecutionPolicy(settings) {
  return normalizeExecutionPolicy(settings?.executionPolicy, legacyExecutionPolicy(settings?.sandbox, settings?.approvalPolicy));
}

export function executionPolicyValue(policy) {
  const normalized = normalizeExecutionPolicy(policy);
  return `${normalized.access}|${normalized.approval}`;
}

export function policyFromValue(value) {
  const [access, approval] = String(value || '').split('|');
  return normalizeExecutionPolicy({ contract: EXECUTION_POLICY_CONTRACT, access, approval });
}

export function executionPolicyPresets(catalog, providerId, currentPolicy = null, includeInherit = false) {
  const entry = (Array.isArray(catalog) ? catalog : []).find(item => item?.id === providerId);
  const capability = entry?.execution_policy;
  const combinations = capability?.combinations || [];
  const transport = catalogTransport(entry);
  const options = EXECUTION_POLICY_PRESETS.map(preset => {
    const matching = combinations.filter(item => item?.access === preset.access && item?.approval === preset.approval);
    const scoped = transport ? matching.filter(item => !Array.isArray(item.transports) || item.transports.includes(transport)) : matching;
    const declaration = scoped[0] || matching[0];
    const supported = !capability || (declaration && declaration.support !== 'unsupported');
    return {
      ...preset,
      value: `${preset.access}|${preset.approval}`,
      disabled: !supported,
      reason: declaration?.reason || (!supported ? '当前 Provider/transport 不支持该组合' : ''),
    };
  });
  const current = currentPolicy ? executionPolicyValue(currentPolicy) : '';
  if (current && !options.some(option => option.value === current)) {
    const normalized = normalizeExecutionPolicy(currentPolicy);
    options.push({
      id: 'historical-custom',
      label: `历史策略：${normalized.access} / ${normalized.approval}`,
      access: normalized.access,
      approval: normalized.approval,
      value: current,
      disabled: false,
      historical: true,
      reason: '历史值会保留，修改前请确认当前 Provider 支持情况',
    });
  }
  return includeInherit ? [{ id: 'inherit', label: '沿用项目设置', value: '', disabled: false }, ...options] : options;
}

export function applyExecutionPolicy(settings, policy) {
  const normalized = normalizeExecutionPolicy(policy);
  const legacy = legacyProjection(normalized);
  return { ...settings, executionPolicy: normalized, sandbox: legacy.sandbox, approvalPolicy: legacy.approval_policy };
}

export function executionPolicyPayload(policy) {
  return normalizeExecutionPolicy(policy);
}

export function isolationLabel(catalog, providerId) {
  const entry = (Array.isArray(catalog) ? catalog : []).find(item => item?.id === providerId);
  const isolation = entry?.execution_policy?.isolation || 'none';
  return ({
    'os-sandbox': 'OS sandbox',
    'tool-policy': 'Provider 工具策略',
    'tool-selection': '工具选择限制',
    none: '无额外隔离',
  })[isolation] || isolation;
}

export function legacyExecutionPolicy(sandbox, approval) {
  const access = ({
    'read-only': 'read-only',
    'workspace-write': 'provider-native-development',
    'danger-full-access': 'unrestricted-host',
  })[String(sandbox || '').trim()] || 'provider-native-development';
  const approvalValue = ({
    never: 'unattended',
    'danger-only': 'ask-sensitive',
    'on-request': 'ask-sensitive',
    always: 'ask-every-side-effect',
    untrusted: 'ask-every-side-effect',
  })[String(approval || '').trim()] || 'unattended';
  return { contract: EXECUTION_POLICY_CONTRACT, access, approval: approvalValue };
}

function legacyProjection(policy) {
  return {
    sandbox: policy.access === 'read-only' ? 'read-only' : policy.access === 'provider-native-development' ? 'workspace-write' : 'danger-full-access',
    approval_policy: policy.approval === 'unattended' ? 'never' : policy.approval === 'ask-sensitive' ? 'danger-only' : 'always',
  };
}

function parsePolicy(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.contract !== EXECUTION_POLICY_CONTRACT) return null;
  if (!['read-only', 'provider-native-development', 'unrestricted-host'].includes(raw.access)) return null;
  if (!['unattended', 'ask-sensitive', 'ask-every-side-effect'].includes(raw.approval)) return null;
  return { contract: EXECUTION_POLICY_CONTRACT, access: raw.access, approval: raw.approval };
}

function catalogTransport(entry) {
  const mode = String(entry?.runtime?.mode || '').trim();
  return mode === 'cli-fallback' ? 'stdio-json' : mode;
}
