/**
 * Codex Issue Runner API 客户端。
 *
 * 这里不做本地假数据或 localStorage 降级：前端展示的数据必须来自当前 Runner 后端。
 * 后端未连接时，请求会直接抛错，由页面显示 DISCONNECTED / 错误态。
 */
import { authHeader, clearAuthToken, ensureAuthCookie } from './authToken';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const EVENT_SOURCE_CLOSED = 2;

let sharedEventSource = null;
const eventSubscribers = new Set();

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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

async function uploadImage(file) {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_BASE}/api/uploads/images`, {
    method: 'POST',
    headers: authHeader(),
    body: formData,
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return response.json();
}

async function responseError(response) {
  const error = new Error(await readErrorMessage(response));
  error.status = response.status;
  return error;
}

function subscribeToEvents(onEvent, onError, onOpen) {
  const subscriber = { onEvent, onError, onOpen };
  eventSubscribers.add(subscriber);
  ensureSharedEventSource();

  return () => {
    eventSubscribers.delete(subscriber);
    if (eventSubscribers.size === 0) {
      sharedEventSource?.close();
      sharedEventSource = null;
    }
  };
}

function ensureSharedEventSource() {
  if (sharedEventSource && sharedEventSource.readyState !== EVENT_SOURCE_CLOSED) {
    return sharedEventSource;
  }

  ensureAuthCookie();
  sharedEventSource = new EventSource(`${API_BASE}/api/events`);
  sharedEventSource.onopen = () => {
    for (const subscriber of eventSubscribers) {
      subscriber.onOpen?.();
    }
  };
  sharedEventSource.onmessage = (event) => {
    dispatchEventMessage(event);
  };
  sharedEventSource.onerror = (err) => {
    for (const subscriber of eventSubscribers) {
      subscriber.onError?.(err);
    }
  };
  return sharedEventSource;
}

function dispatchEventMessage(event) {
  try {
    const data = JSON.parse(event.data);
    for (const subscriber of eventSubscribers) {
      subscriber.onEvent?.(data);
    }
  } catch (err) {
    console.error('解析 SSE 消息失败:', err, event.data);
  }
}


export const api = {
  validateAuthToken: () => request('/api/system/status'),

  clearAuthToken,

  getProjects: () => request('/api/projects'),

  getAgentProfiles: () => request('/api/agent-profiles'),

  createAgentProfile: (profile) => request('/api/agent-profiles', {
    method: 'POST',
    body: JSON.stringify(profile),
  }),

  updateAgentProfile: (id, updates) => request(`/api/agent-profiles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  deleteAgentProfile: (id) => request(`/api/agent-profiles/${id}`, {
    method: 'DELETE',
  }),

  syncCodexProjects: () => request('/api/projects/sync/codex', {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  createProject: (project) => request('/api/projects', {
    method: 'POST',
    body: JSON.stringify(project),
  }),

  getProject: (id) => request(`/api/projects/${id}`),

  updateProject: (id, updates) => request(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  reorderProjects: (projectIds) => request('/api/projects', {
    method: 'PATCH',
    body: JSON.stringify({ project_ids: projectIds }),
  }),

  deleteProject: (id) => request(`/api/projects/${id}`, {
    method: 'DELETE',
  }),

  startProjectLoop: (id) => request(`/api/projects/${id}/loop/start`, {
    method: 'POST',
  }),

  stopProjectLoop: (id) => request(`/api/projects/${id}/loop/stop`, {
    method: 'POST',
  }),

  getProjectLoopStatus: (id) => request(`/api/projects/${id}/loop/status`),

  resumeProjectHold: (id) => request(`/api/projects/${id}/hold/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  getIssueTemplates: () => request('/api/issue-templates'),

  createIssueTemplate: (template) => request('/api/issue-templates', {
    method: 'POST',
    body: JSON.stringify(template),
  }),

  updateIssueTemplate: (id, updates) => request(`/api/issue-templates/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  deleteIssueTemplate: (id) => request(`/api/issue-templates/${id}`, {
    method: 'DELETE',
  }),

  getCodexUsage: (limit = 0) => {
    const query = limit > 0 ? `?limit=${encodeURIComponent(limit)}` : '';
    return request(`/api/usage/codex${query}`);
  },

  getSystemStatus: () => request('/api/system/status'),

  getPiConnectors: () => request('/api/pi/connectors'),

  getPiSkills: () => request('/api/pi/skills'),

  getPiSkill: (id) => request(`/api/pi/skills/${encodeURIComponent(id)}`),

  getPiActivityTimeline: ({ source = '', inboxItemId = '', proposalId = '', issueId = '', since = '', until = '', limit = 100 } = {}) => {
    const params = new URLSearchParams();
    if (source) params.append('source', source);
    if (inboxItemId) params.append('inbox_item_id', String(inboxItemId));
    if (proposalId) params.append('proposal_id', proposalId);
    if (issueId) params.append('issue_id', String(issueId));
    if (since) params.append('since', since);
    if (until) params.append('until', until);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/activity${query}`);
  },

  getPiSkillIntakeRuns: ({ bundleId = '', skillId = '', status = '', limit = 50 } = {}) => {
    const params = new URLSearchParams();
    if (bundleId) params.append('bundle_id', String(bundleId));
    if (skillId) params.append('skill_id', skillId);
    if (status) params.append('status', status);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/skills/intake-runs${query}`);
  },

  getPiSkillDomainRuns: ({ itemId = '', skillId = '', status = '', limit = 50 } = {}) => {
    const params = new URLSearchParams();
    if (itemId) params.append('item_id', String(itemId));
    if (skillId) params.append('skill_id', skillId);
    if (status) params.append('status', status);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/skills/domain-runs${query}`);
  },

  runPiSkillIntake: (id, bundleId) => request(`/api/pi/skills/${encodeURIComponent(id)}/intake-runs`, {
    method: 'POST',
    body: JSON.stringify({ bundle_id: bundleId }),
  }),

  runPiSkillDomain: (id, itemId) => request(`/api/pi/skills/${encodeURIComponent(id)}/domain-runs`, {
    method: 'POST',
    body: JSON.stringify({ item_id: itemId }),
  }),

  getPiAttentionItems: ({ status = '', source = '', limit = 100 } = {}) => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (source) params.append('source', source);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/attention-inbox/items${query}`);
  },

  getPiAttentionItem: (id) => request(`/api/pi/attention-inbox/items/${encodeURIComponent(id)}`),

  updatePiAttentionItem: (id, updates) => request(`/api/pi/attention-inbox/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  ignorePiAttentionItem: (id) => request(`/api/pi/attention-inbox/items/${encodeURIComponent(id)}/ignore`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  reintakePiAttentionItem: (id) => request(`/api/pi/attention-inbox/items/${encodeURIComponent(id)}/reintake`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  startPiAttentionDomainSkill: (id) => request(`/api/pi/attention-inbox/items/${encodeURIComponent(id)}/domain-skill`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  getPiAttentionContextBundle: (id) => request(`/api/pi/attention-inbox/context-bundles/${encodeURIComponent(id)}`),

  getPiAttentionContextBundles: ({ source = '', limit = 100 } = {}) => {
    const params = new URLSearchParams();
    if (source) params.append('source', source);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/attention-inbox/context-bundles${query}`);
  },

  getPiAttentionIntakeRun: (id) => request(`/api/pi/attention-inbox/intake-runs/${encodeURIComponent(id)}`),

  getPiAttentionRawEvent: (id) => request(`/api/pi/attention-inbox/raw-events/${encodeURIComponent(id)}`),

  getPiActionProposals: ({ sourceItemId = '', status = '' } = {}) => {
    const params = new URLSearchParams();
    if (sourceItemId) params.append('source_item_id', sourceItemId);
    if (status) params.append('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/action-proposals${query}`);
  },

  approvePiActionProposal: (id, payload = {}) => request(`/api/pi/action-proposals/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  rejectPiActionProposal: (id, payload = {}) => request(`/api/pi/action-proposals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  getRunnerSettings: () => request('/api/runner/settings'),

  updateRunnerSettings: (settings) => request('/api/runner/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  }),

  getRuntimeDoctor: () => request('/api/system/doctor'),

  getRuntimeLogs: (lines = 120) => request(`/api/system/logs?lines=${encodeURIComponent(lines)}`),

  executeCommand: (payload) => request('/api/commands', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  restartSystem: () => request('/api/system/restart', {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  getFeishuSettings: () => request('/api/integrations/feishu/settings'),

  updateFeishuSettings: (settings) => request('/api/integrations/feishu/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  }),

  getCronTasks: () => request('/api/cron-tasks'),

  createCronTask: (task) => request('/api/cron-tasks', {
    method: 'POST',
    body: JSON.stringify(task),
  }),

  updateCronTask: (id, updates) => request(`/api/cron-tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  deleteCronTask: (id) => request(`/api/cron-tasks/${id}`, {
    method: 'DELETE',
  }),

  getIssues: (projectId = '', status = '') => {
    const params = new URLSearchParams();
    if (projectId) params.append('projectId', projectId);
    if (status) params.append('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/issues${query}`);
  },

  createIssue: (issue) => request('/api/issues', {
    method: 'POST',
    body: JSON.stringify(issue),
  }),

  getIssue: (id) => request(`/api/issues/${id}`),

  updateIssue: (id, updates) => request(`/api/issues/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  enqueueIssue: (id, payload = {}) => request(`/api/issues/${id}/enqueue`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  retryIssue: (id, payload = {}) => request(`/api/issues/${id}/retry`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  cancelIssue: (id) => request(`/api/issues/${id}/cancel`, {
    method: 'POST',
  }),

  deleteIssue: (id) => request(`/api/issues/${id}`, {
    method: 'DELETE',
  }),

  reviewIssueVerification: (id, review) => request(`/api/issues/${id}/verification`, {
    method: 'POST',
    body: JSON.stringify(review),
  }),

  getIssueEvents: (id) => request(`/api/issues/${id}/events`),

  getIssueRuns: (id) => request(`/api/issues/${id}/runs`),

  getIssueSupervisor: (id) => request(`/api/issues/${id}/supervisor`),

  createIssueComment: (id, comment) => request(`/api/issues/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify(comment),
  }),

  generateIssueVerifierReport: (id) => request(`/api/issues/${id}/verifier-report`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  getSessions: ({ limit = 50, cursor = '' } = {}) => {
    const params = new URLSearchParams();
    if (limit) params.append('limit', String(limit));
    if (cursor) params.append('cursor', cursor);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/sessions${query}`);
  },

  getCodexModels: () => request('/api/codex/models'),

  getCapabilities: () => request('/api/capabilities'),

  getPiAgents: () => request('/api/pi/agents'),

  getPiAgentRuntimePrompt: (id) => request(`/api/pi/agents/${encodeURIComponent(id)}/runtime-prompt`),

  updatePiAgent: (id, updates) => request(`/api/pi/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  getPiProviderSettings: () => request('/api/pi/provider-settings'),

  updatePiProviderSettings: (id, settings) => request(`/api/pi/provider-settings/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(settings),
  }),

  getPiCodexOAuthStatus: () => request('/api/pi/oauth/openai-codex/status'),

  startPiCodexOAuthLogin: () => request('/api/pi/oauth/openai-codex/login', {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  logoutPiCodexOAuth: () => request('/api/pi/oauth/openai-codex/logout', {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  getPiConversations: ({ projectId = '', status = '' } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    if (status) params.append('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/conversations${query}`);
  },


  createPiConversation: (conversation) => request('/api/pi/conversations', {
    method: 'POST',
    body: JSON.stringify(conversation),
  }),

  getPiConversation: (id) => request(`/api/pi/conversations/${encodeURIComponent(id)}`),


  sendPiConversationMessage: (id, message) => request(`/api/pi/conversations/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify(typeof message === 'string' ? { prompt: message } : message),
  }),

  getPiMcpCapabilities: () => request('/api/pi/mcp/capabilities'),

  getPiHeartbeatTimeline: ({ projectId = '', issueId = '', limit = 80 } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    if (issueId) params.append('issue_id', issueId);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/heartbeat-timeline${query}`);
  },

  getPiReports: ({ projectId = '', limit = 6 } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/reports${query}`);
  },

  getPiGuardianRunGroups: ({ projectId = '', status = '' } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    if (status) params.append('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/guardian/run-groups${query}`);
  },

  getPiGuardianRunGroup: (id) => request(`/api/pi/guardian/run-groups/${encodeURIComponent(id)}`),

  getPiGuardianNotificationIntents: ({ issueId = '', kind = '', projectId = '', runGroupId = '', state = '' } = {}) => {
    const params = new URLSearchParams();
    if (issueId) params.append('issue_id', String(issueId));
    if (kind) params.append('kind', kind);
    if (projectId) params.append('project_id', projectId);
    if (runGroupId) params.append('run_group_id', runGroupId);
    if (state) params.append('state', state);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/guardian/notification-intents${query}`);
  },

  getPiGuardianPreferences: ({ conversationId = '', projectId = '', runGroupId = '', scope = '', status = '' } = {}) => {
    const params = new URLSearchParams();
    if (conversationId) params.append('conversation_id', conversationId);
    if (projectId) params.append('project_id', projectId);
    if (runGroupId) params.append('run_group_id', runGroupId);
    if (scope) params.append('scope', scope);
    if (status) params.append('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/guardian/preferences${query}`);
  },

  createPiGuardianPreference: (preference) => request('/api/pi/guardian/preferences', {
    method: 'POST',
    body: JSON.stringify(preference),
  }),

  disablePiGuardianPreference: (id) => request(`/api/pi/guardian/preferences/${encodeURIComponent(id)}/disable`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  flushPiGuardianDigest: ({ limit = 0, now = '', runGroupId = '' } = {}) => request('/api/pi/guardian/digest/flush', {
    method: 'POST',
    body: JSON.stringify({
      ...(limit ? { limit } : {}),
      ...(now ? { now } : {}),
      ...(runGroupId ? { run_group_id: runGroupId } : {}),
    }),
  }),

  getPiGuardianAlerts: ({ alertType = '', projectId = '', status = 'open' } = {}) => {
    const params = new URLSearchParams();
    if (alertType) params.append('alert_type', alertType);
    if (projectId) params.append('project_id', projectId);
    if (status) params.append('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/guardian/alerts${query}`);
  },

  ackPiGuardianAlert: (id) => request(`/api/pi/guardian/alerts/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  getPiDelegations: ({ projectId = '', status = '' } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    if (status) params.append('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/delegations${query}`);
  },

  createPiDelegation: (delegation) => request('/api/pi/delegations', {
    method: 'POST',
    body: JSON.stringify(delegation),
  }),

  pausePiDelegation: (id) => request(`/api/pi/delegations/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  resumePiDelegation: (id) => request(`/api/pi/delegations/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  updatePiDelegation: (id, updates) => request(`/api/pi/delegations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  expirePiDelegation: (id) => request(`/api/pi/delegations/${encodeURIComponent(id)}/expire`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  searchProjectReferences: (id, { type = '', query = '', limit = 40 } = {}) => {
    const params = new URLSearchParams();
    if (type) params.append('type', type);
    if (query) params.append('query', query);
    if (limit) params.append('limit', String(limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/projects/${id}/references/search${qs}`);
  },

  getSessionPreferences: () => request('/api/sessions/preferences'),

  createSession: (session) => request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(session),
  }),

  getSession: (id) => request(`/api/sessions/${id}`),

  sendSessionMessage: (id, message) => request(`/api/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify(typeof message === 'string' ? { prompt: message } : message),
  }),

  steerSessionMessage: (id, message) => request(`/api/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ ...(typeof message === 'string' ? { prompt: message } : message), mode: 'steer' }),
  }),

  interruptSession: (id) => request(`/api/sessions/${id}/interrupt`, {
    method: 'POST',
  }),

  resolveCodexApproval: (id, decision) => request(`/api/codex/approvals/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify(decision),
  }),

  uploadImage,

  subscribeToEvents,
};
