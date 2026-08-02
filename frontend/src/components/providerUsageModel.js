const SELECTED_PROVIDER_KEY = 'ai-usage-selected-provider-v1';

export function availableUsageProviders(status, usage) {
  const reports = usageReports(usage);
  const reportIDs = new Set(reports.map(report => report.provider?.id).filter(Boolean));
  const configured = Array.isArray(status?.providers)
    ? status.providers.filter(provider => provider?.enabled !== false && provider?.role !== 'manager')
    : [];
  const available = configured.filter(provider => (
    provider.available === true || provider.ready === true || provider.status === 'available'
  ) && reportIDs.has(provider.id));
  if (available.length > 0) return available;
  const known = configured.filter(provider => reportIDs.has(provider.id));
  if (known.length > 0) return known;
  return reports.map(report => ({ id: report.provider.id, label: providerLabel(report.provider.id), status: 'unknown' }));
}

export function selectedUsageProvider(providers, selectedID) {
  if (!providers.length) return null;
  return providers.find(provider => provider.id === selectedID)
    || providers.find(provider => provider.id === 'codex')
    || providers[0];
}

export function providerUsageReport(usage, providerID) {
  return usageReports(usage).find(report => report.provider?.id === providerID) || null;
}

export function readSelectedUsageProvider(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    return String(target?.getItem(SELECTED_PROVIDER_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function writeSelectedUsageProvider(providerID, storage) {
  if (!providerID) return;
  try {
    const target = storage ?? globalThis.localStorage;
    target?.setItem(SELECTED_PROVIDER_KEY, providerID);
  } catch {
    // localStorage 不可用时仅保留当前页面选择。
  }
}

function usageReports(usage) {
  return Array.isArray(usage?.providers)
    ? usage.providers.filter(report => report?.provider?.id)
    : [];
}

function providerLabel(providerID) {
  if (providerID === 'codex') return 'Codex';
  if (providerID === 'claude') return 'Claude';
  return providerID;
}
