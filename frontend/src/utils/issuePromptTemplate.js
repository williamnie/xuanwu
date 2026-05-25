const ISSUE_TITLE_MAX_RUNES = 50;

export const ISSUE_PROMPT_TEMPLATE_VARIABLES = Object.freeze([
  'project.id',
  'project.name',
  'project.cwd',
  'issue.id',
  'issue.title',
  'issue.content',
  'issue.description',
  'issue.priority',
]);

const KNOWN_VARIABLES = new Set(ISSUE_PROMPT_TEMPLATE_VARIABLES);
const TEMPLATE_TOKEN_RE = /\{\{([^{}]+)\}\}/g;

export function extractIssueTemplateVariables(template) {
  const used = [];
  const unknown = [];
  const seen = new Set();
  const unknownSeen = new Set();

  for (const match of String(template || '').matchAll(TEMPLATE_TOKEN_RE)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      used.push(name);
    }
    if (!KNOWN_VARIABLES.has(name) && !unknownSeen.has(name)) {
      unknownSeen.add(name);
      unknown.push(name);
    }
  }

  return { used, unknown };
}

export function renderIssuePromptTemplate(template, { project = {}, issue = {} } = {}) {
  const values = issuePromptTemplateValues(project, issue);
  return String(template || '').replace(TEMPLATE_TOKEN_RE, (token, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : token
  ));
}

export function deriveIssuePreviewTitle(description) {
  const line = firstNonEmptyLine(description);
  const runes = Array.from(line);
  if (runes.length <= ISSUE_TITLE_MAX_RUNES) return line;
  return `${runes.slice(0, ISSUE_TITLE_MAX_RUNES - 1).join('')}…`;
}

function issuePromptTemplateValues(project, issue) {
  project = project || {};
  issue = issue || {};

  const description = cleanText(issue.description);
  const title = cleanText(issue.title) || deriveIssuePreviewTitle(description);
  return {
    'project.id': cleanText(project.id),
    'project.name': cleanText(project.name),
    'project.cwd': cleanText(project.cwd),
    'issue.id': cleanText(issue.id),
    'issue.title': title,
    'issue.content': description || title,
    'issue.description': description,
    'issue.priority': String(parseIssuePriority(issue.priority)),
  };
}

function parseIssuePriority(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNonEmptyLine(content) {
  for (const line of String(content || '').split('\n')) {
    const text = line.trim();
    if (text) return text;
  }
  return '';
}

function cleanText(value) {
  return String(value ?? '').trim();
}
