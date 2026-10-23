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

export function normalizeServiceTier(value) {
  return String(value || '').trim();
}
