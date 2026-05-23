const TOKEN_KEY = 'codex-runner-auth-token';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setAuthToken(token) {
  const value = token.trim();
  if (value) {
    localStorage.setItem(TOKEN_KEY, value);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
  document.cookie = `codex_runner_token=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${value ? COOKIE_MAX_AGE_SECONDS : 0}`;
}

export function clearAuthToken() {
  setAuthToken('');
}

export function authHeader() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
