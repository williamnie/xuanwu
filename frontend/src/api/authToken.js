const TOKEN_KEY = 'codex-runner-auth-token';
const COOKIE_NAME = 'codex_runner_token';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function getAuthToken() {
  return readStorageToken() || readCookieToken();
}

export function setAuthToken(token) {
  const value = token.trim();
  if (value) {
    writeStorageToken(value);
  } else {
    clearStorageToken();
  }
  writeCookieToken(value);
}

export function clearAuthToken() {
  setAuthToken('');
}

export function authHeader() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function readStorageToken() {
  if (typeof localStorage === 'undefined') {
    return '';
  }
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function writeStorageToken(token) {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Cookie fallback keeps same-origin API and SSE auth available.
  }
}

function clearStorageToken() {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage cleanup failures; cookie cleanup still runs below.
  }
}

function readCookieToken() {
  if (typeof document === 'undefined') {
    return '';
  }
  const prefix = `${COOKIE_NAME}=`;
  const cookies = String(document.cookie || '').split(';');
  for (const cookie of cookies) {
    const item = cookie.trim();
    if (item.startsWith(prefix)) {
      return decodeCookieValue(item.slice(prefix.length));
    }
  }
  return '';
}

function writeCookieToken(token) {
  if (typeof document === 'undefined') {
    return;
  }
  const maxAge = token ? COOKIE_MAX_AGE_SECONDS : 0;
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
