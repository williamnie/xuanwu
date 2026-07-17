export const DEFAULT_ACTIVITY_FILTERS = Object.freeze({
  conversationId: '',
  decision: '',
  inboxItemId: '',
  issueId: '',
  limit: 100,
  proposalId: '',
  since: '',
  source: '',
  stage: '',
  status: '',
  until: '',
});

export function filterActivityAuditItems(items = [], filters = {}) {
  const stage = clean(filters.stage);
  const status = clean(filters.status);
  const decision = clean(filters.decision);
  return items.filter(item => (
    matches(item.stage, stage) &&
    matches(item.status, status) &&
    matches(item.decision, decision)
  ));
}

export function activityAuditFilterOptions(items = []) {
  return {
    decisions: distinct(items.map(item => item.decision)),
    stages: distinct(items.map(item => item.stage)),
    statuses: distinct(items.map(item => item.status)),
  };
}

export function cleanActivityFilters(filters) {
  return Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

function matches(value, expected) {
  return expected === '' || clean(value).toLowerCase() === expected.toLowerCase();
}

function distinct(values) {
  return [...new Set(values.map(clean).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}
