/* global __XUANWU_APP_VERSION__ */

export const FALLBACK_APP_VERSION = 'unknown';
const BAD_STAMP_STATUSES = new Set(['runtime_stamp_missing', 'dist_stamp_missing', 'dist_stamp_error', 'mismatch']);

export function resolveAppVersion(rawVersion, fallbackVersion = FALLBACK_APP_VERSION) {
  const value = typeof rawVersion === 'string' ? rawVersion.trim() : '';
  const fallback = typeof fallbackVersion === 'string' ? fallbackVersion.trim() : '';
  return value || fallback || FALLBACK_APP_VERSION;
}

export function buildVersionSummary(frontendVersion, status = {}) {
  const backendVersion = resolveAppVersion(status.service?.version || status.service?.build?.version);
  const frontend = resolveAppVersion(frontendVersion);
  const build = status.service?.build || {};
  const stampStatus = build.dist_stamp_status || 'not_checked';
  const warnings = versionWarnings(frontend, backendVersion, stampStatus);
  return {
    frontendVersion: frontend,
    backendVersion,
    buildStamp: build.stamp || '',
    distStampStatus: stampStatus,
    warnings,
    ok: warnings.length === 0,
  };
}

function versionWarnings(frontendVersion, backendVersion, stampStatus) {
  const warnings = [];
  if (frontendVersion !== backendVersion) {
    warnings.push(`Frontend ${frontendVersion} 与 Backend ${backendVersion} 不一致`);
  }
  if (frontendVersion === FALLBACK_APP_VERSION || backendVersion === FALLBACK_APP_VERSION) {
    warnings.push('未检测到可用版本，请确认 build 注入或 git 信息是否可用');
  }
  if (BAD_STAMP_STATUSES.has(stampStatus)) {
    warnings.push(`Build stamp 状态异常: ${stampStatus}`);
  }
  return warnings;
}

const INJECTED_APP_VERSION = typeof __XUANWU_APP_VERSION__ === 'string'
  ? __XUANWU_APP_VERSION__
  : '';

export const APP_VERSION = resolveAppVersion(import.meta.env?.VITE_APP_VERSION, INJECTED_APP_VERSION);
