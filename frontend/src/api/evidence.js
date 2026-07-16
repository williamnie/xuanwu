import { apiUrl, request } from './base.js';
import { authHeader } from './authToken.js';
import { ApiError } from './errors.js';

export function evidenceListPath({
  cursor = '',
  issueId = '',
  kind = '',
  limit = 5,
  projectId = '',
  runId = '',
  sessionRef = '',
  status = '',
  workId = '',
} = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  if (issueId) params.set('issue_id', String(issueId));
  if (kind) params.set('kind', kind);
  if (projectId) params.set('project_id', projectId);
  if (runId) params.set('run_id', runId);
  if (sessionRef) params.set('session_ref', sessionRef);
  if (status) params.set('status', status);
  if (workId) params.set('work_id', workId);
  return `/api/evidence?${params.toString()}`;
}

export const evidenceApi = {
  listEvidence: (filters = {}) => request(evidenceListPath(filters)),

  getEvidence: (id) => request(`/api/evidence/${encodeURIComponent(id)}`),

  downloadArtifact: async (id, index) => {
    const response = await fetch(apiUrl(`/api/evidence/${encodeURIComponent(id)}/artifacts/${index}`), {
      headers: authHeader(),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text || `下载失败: ${response.status}`;
      try {
        message = JSON.parse(text)?.message || message;
      } catch {
        // 保留文本错误。
      }
      throw new ApiError(message, response.status);
    }
    return {
      blob: await response.blob(),
      filename: responseFilename(response.headers.get('content-disposition')),
    };
  },
};

function responseFilename(disposition) {
  const match = /filename="([^"]+)"/i.exec(String(disposition || ''));
  return match?.[1] || 'evidence-artifact';
}
