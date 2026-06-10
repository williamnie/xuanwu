const DEFAULT_PRIORITY = 0;
const TITLE_MAX_CHARS = 50;
const VALID_PRIORITIES = new Set([0, 1, 2]);

export function canEditIssue(issue) {
  return issue?.status === 'triage';
}

export function issueToEditDraft(issue) {
  return {
    title: issue?.title || '',
    description: issue?.description || '',
    priority: String(normalizePriority(issue?.priority)),
  };
}

export function validateIssueDraft(draft) {
  if (!cleanText(draft?.description)) {
    return '任务内容不能为空';
  }
  return '';
}

export function issueDraftToPatch(draft) {
  const description = cleanText(draft.description);
  return {
    title: cleanText(draft.title) || deriveIssueTitle(description),
    description,
    priority: normalizePriority(draft.priority),
  };
}

function normalizePriority(value) {
  const priority = Number.parseInt(value, 10);
  return VALID_PRIORITIES.has(priority) ? priority : DEFAULT_PRIORITY;
}

function deriveIssueTitle(description) {
  const firstLine = description.split('\n').find(line => line.trim())?.trim() || '';
  return truncateText(firstLine, TITLE_MAX_CHARS);
}

function truncateText(value, maxChars) {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

function cleanText(value) {
  return String(value || '').trim();
}
