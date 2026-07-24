import { request } from './base.js';
import { streamPiConversationMessage } from './piConversationStream.js';

export const assistantApi = {
  getPiSkills: () => request('/api/pi/skills'),

  getPiSkill: (id) => request(`/api/pi/skills/${encodeURIComponent(id)}`),

  getPiActivityTimeline: ({ source = '', conversationId = '', inboxItemId = '', proposalId = '', issueId = '', since = '', until = '', limit = 100 } = {}) => {
    const params = new URLSearchParams();
    if (source) params.append('source', source);
    if (conversationId) params.append('conversation_id', conversationId);
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

  getPiAttentionContextBundle: (id) => request(`/api/pi/attention-inbox/context-bundles/${encodeURIComponent(id)}`),

  getPiAttentionContextBundles: ({ source = '', limit = 100 } = {}) => {
    const params = new URLSearchParams();
    if (source) params.append('source', source);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/attention-inbox/context-bundles${query}`);
  },

  getPiSupervisor: () => request('/api/pi/supervisor'),

  getPiSupervisorRuntimePrompt: () => request('/api/pi/supervisor/runtime-prompt'),

  updatePiSupervisor: (updates) => request('/api/pi/supervisor', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  getPiProviderSettings: () => request('/api/pi/provider-settings'),

  getPiProviderCatalog: () => request('/api/pi/provider-settings/catalog'),

  updatePiProviderSettings: (id, settings) => request(`/api/pi/provider-settings/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(settings),
  }),

  getPiProviderModels: (id, settings) => request(`/api/pi/provider-settings/${encodeURIComponent(id)}/models`, {
    method: 'POST',
    body: JSON.stringify(settings),
  }),

  testPiProviderConnection: (id, settings) => request(`/api/pi/provider-settings/${encodeURIComponent(id)}/test-connection`, {
    method: 'POST',
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

  sendPiConversationMessage: (id, message, options) => streamPiConversationMessage(id, message, options),

  interruptPiConversation: (id) => request(`/api/pi/conversations/${encodeURIComponent(id)}/interrupt`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

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

};
