export const FALLBACK_APP_VERSION = '0.0.0-dev';

export function resolveAppVersion(rawVersion) {
  const value = typeof rawVersion === 'string' ? rawVersion.trim() : '';
  return value || FALLBACK_APP_VERSION;
}

export const APP_VERSION = resolveAppVersion(import.meta.env?.VITE_APP_VERSION);
