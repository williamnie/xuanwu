import { authHeader } from './authToken.js';
import { ApiError } from './errors.js';
import { storedLanguage } from '../i18n/translations.js';

const API_BASE = import.meta.env?.VITE_API_BASE_URL || '';
const inflightGetRequests = new Map();

/** @param {string} path @param {import('./types.js').ApiRequestOptions} [options] */
export async function request(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const dedupeKey = method === 'GET' && !options.signal ? `${API_BASE}${path}` : '';
  if (dedupeKey && inflightGetRequests.has(dedupeKey)) {
    return inflightGetRequests.get(dedupeKey);
  }
  const pending = executeRequest(path, options);
  if (!dedupeKey) return pending;
  inflightGetRequests.set(dedupeKey, pending);
  try {
    return await pending;
  } finally {
    if (inflightGetRequests.get(dedupeKey) === pending) inflightGetRequests.delete(dedupeKey);
  }
}

async function executeRequest(path, options) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Codex-Client': 'xuanwu-web',
      'Accept-Language': storedLanguage(),
      ...authHeader(),
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function uploadImage(file) {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_BASE}/api/uploads/images`, {
    method: 'POST',
    headers: { ...authHeader(), 'Accept-Language': storedLanguage() },
    body: formData,
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return response.json();
}

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

async function responseError(response) {
  return new ApiError(await readErrorMessage(response), response.status);
}

async function readErrorMessage(response) {
  const text = await response.text();
  if (!text) {
    return `请求失败: ${response.status}`;
  }

  try {
    const data = JSON.parse(text);
    return data.message || `请求失败: ${response.status}`;
  } catch {
    return text;
  }
}
