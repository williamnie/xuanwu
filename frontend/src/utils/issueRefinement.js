export const REFINEMENT_START = '<!-- codex-refinement:start -->';
export const REFINEMENT_END = '<!-- codex-refinement:end -->';

export const REFINEMENT_FIELDS = [
  { id: 'problem', label: 'Problem' },
  { id: 'context', label: 'Context / impacted files' },
  { id: 'acceptanceCriteria', label: 'Acceptance criteria' },
  { id: 'verificationPlan', label: 'Verification plan' },
  { id: 'nonGoals', label: 'Non-goals' },
  { id: 'risks', label: 'Risks / questions' },
];

export function emptyIssueRefinement() {
  return Object.fromEntries(REFINEMENT_FIELDS.map(field => [field.id, '']));
}

export function parseIssueRefinement(description) {
  const text = String(description || '');
  const start = text.indexOf(REFINEMENT_START);
  const end = text.indexOf(REFINEMENT_END);
  if (start < 0 || end < start) {
    return { body: text, refinement: emptyIssueRefinement(), hasBlock: false };
  }

  const block = text.slice(start + REFINEMENT_START.length, end);
  const body = `${text.slice(0, start)}\n${text.slice(end + REFINEMENT_END.length)}`.trim();
  return { body, refinement: parseRefinementBlock(block), hasBlock: true };
}

export function serializeIssueRefinement(description, refinement) {
  const { body } = parseIssueRefinement(description);
  const cleanRefinement = normalizeRefinement(refinement);
  if (!hasAnyRefinementContent(cleanRefinement)) {
    return body;
  }
  const block = buildRefinementBlock(cleanRefinement);
  return [body, block].filter(Boolean).join('\n\n').trim();
}

export function issueRefinementReadiness(refinement) {
  const acceptanceReady = cleanText(refinement?.acceptanceCriteria) !== '';
  const verificationReady = cleanText(refinement?.verificationPlan) !== '';
  const missing = [];
  if (!acceptanceReady) missing.push('Acceptance criteria');
  if (!verificationReady) missing.push('Verification plan');
  return { ready: missing.length === 0, missing };
}

function parseRefinementBlock(block) {
  const refinement = emptyIssueRefinement();
  const labels = new Map(REFINEMENT_FIELDS.map(field => [normalizeLabel(field.label), field.id]));
  let current = '';
  for (const line of String(block || '').split('\n')) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = labels.get(normalizeLabel(heading[1])) || '';
      continue;
    }
    if (current) {
      refinement[current] = `${refinement[current] || ''}${line}\n`;
    }
  }
  return normalizeRefinement(refinement);
}

function buildRefinementBlock(refinement) {
  const lines = [REFINEMENT_START, '## Refinement'];
  for (const field of REFINEMENT_FIELDS) {
    lines.push('', `### ${field.label}`, cleanText(refinement[field.id]));
  }
  lines.push('', REFINEMENT_END);
  return lines.join('\n');
}

function normalizeRefinement(refinement) {
  const clean = emptyIssueRefinement();
  for (const field of REFINEMENT_FIELDS) {
    clean[field.id] = cleanText(refinement?.[field.id]);
  }
  return clean;
}

function hasAnyRefinementContent(refinement) {
  return REFINEMENT_FIELDS.some(field => refinement[field.id]);
}

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeLabel(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}
