export const SERVICE_TIER_STANDARD = '';
export const SERVICE_TIER_FAST = 'priority';

export const SERVICE_TIER_OPTIONS = [
  { value: SERVICE_TIER_STANDARD, label: '标准', shortLabel: '标准' },
  { value: SERVICE_TIER_FAST, label: '快速', shortLabel: '快速', description: '1.5x speed, increased usage' },
];

export function serviceTierOptions(selectedValue = SERVICE_TIER_STANDARD) {
  const normalized = normalizeServiceTier(selectedValue);
  if (!normalized || SERVICE_TIER_OPTIONS.some(option => option.value === normalized)) {
    return SERVICE_TIER_OPTIONS;
  }
  return [...SERVICE_TIER_OPTIONS, { value: normalized, label: normalized, shortLabel: normalized }];
}

export function serviceTierLabel(value) {
  const normalized = normalizeServiceTier(value);
  const option = serviceTierOptions(normalized).find(item => item.value === normalized);
  return option?.label || normalized || '标准';
}

export function serviceTierShortLabel(value) {
  const normalized = normalizeServiceTier(value);
  const option = serviceTierOptions(normalized).find(item => item.value === normalized);
  return option?.shortLabel || option?.label || normalized || '标准';
}

export function serviceTierSourceLabel(source) {
  switch (String(source || '').trim()) {
    case 'issue':
      return 'Issue override';
    case 'agent_profile':
      return 'Agent Profile';
    case 'project':
      return 'Project default';
    case 'standard':
    case '':
      return '标准默认';
    default:
      return source;
  }
}

export function serviceTierRunLabel(run) {
  const tier = normalizeServiceTier(run?.service_tier || run?.runtime_metadata?.service_tier);
  const source = run?.service_tier_source || run?.runtime_metadata?.service_tier_source || '';
  const label = serviceTierLabel(tier);
  const sourceLabel = serviceTierSourceLabel(source);
  return sourceLabel ? `${label} · ${sourceLabel}` : label;
}

export function serviceTierPayload(value) {
  return { service_tier: normalizeServiceTier(value) };
}

export function normalizeServiceTier(value) {
  return String(value || '').trim();
}
