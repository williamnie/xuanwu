export const sourceForForm = form => form.api === 'openai-codex-responses' ? form.credentialSource || 'stored' : 'stored';
export const credentialReady = (form, status) => sourceForForm(form) === 'codex_login'
  ? Boolean(status?.codex_login?.available)
  : Boolean(status?.pi_oauth?.configured);
export const sourceMatches = (form, result) => !result || (result.credentialSource || 'stored') === sourceForForm(form);
export function credentialSourcePayload(form) {
  return form.api === 'openai-codex-responses' ? { credential_source: sourceForForm(form) } : {};
}
export function recommendCodexLogin(supervisor, providers, status) {
  if (!status?.codex_login?.available || status?.pi_oauth?.configured || supervisor?.credential_source === 'codex_login') return false;
  return !providers.some(provider => provider.api_key_configured || provider.api === 'openai-codex-responses');
}
export function codexLoginMessage(status) {
  if (status?.available) return 'credential.available';
  if (status?.error === 'codex_login_unsupported') return 'credential.unsupported';
  if (['codex_provider_disabled', 'codex_provider_unavailable', 'codex_account_unavailable'].includes(status?.error)) return 'credential.providerUnavailable';
  if (status?.error === 'codex_login_home_mismatch') return 'credential.homeMismatch';
  if (status?.error === 'codex_login_refresh_failed') return 'credential.retry';
  return 'credential.loginRequired';
}
