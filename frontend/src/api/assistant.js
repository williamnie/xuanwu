import { request } from './base.js';

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
};
