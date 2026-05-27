export const REFINEMENT_START = '<!-- codex-refinement:start -->';
export const REFINEMENT_END = '<!-- codex-refinement:end -->';

export const REFINEMENT_FIELDS = [
  { id: 'problem', label: 'Problem', group: 'spec' },
  { id: 'context', label: 'Context / impacted files', group: 'spec' },
  { id: 'acceptanceCriteria', label: 'Acceptance criteria', group: 'spec' },
  { id: 'verificationPlan', label: 'Verification plan', group: 'spec' },
  { id: 'nonGoals', label: 'Non-goals', group: 'spec' },
  { id: 'risks', label: 'Risks / questions', group: 'spec' },
  { id: 'recommendedProfile', label: 'Recommended profile', group: 'recommendation' },
  { id: 'recommendedProvider', label: 'Recommended provider', group: 'recommendation' },
  { id: 'riskLevel', label: 'Risk level', group: 'recommendation' },
  { id: 'recommendationReasoning', label: 'Reasoning / why this profile fits', group: 'recommendation' },
  { id: 'needsHumanConfirmation', label: 'Needs human confirmation', group: 'recommendation' },
];

export const REFINEMENT_SPEC_FIELDS = REFINEMENT_FIELDS.filter(field => field.group === 'spec');
export const REFINEMENT_RECOMMENDATION_FIELDS = REFINEMENT_FIELDS.filter(field => field.group === 'recommendation');

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

export function deriveTriageReadiness({ issue, refinement, commentEvents } = {}) {
  if (issue?.status !== 'triage') {
    return null;
  }
  const cleanRefinement = normalizeRefinement(
    refinement || parseIssueRefinement(issue?.description).refinement
  );
  const readiness = issueRefinementReadiness(cleanRefinement);
  const hasRefinement = hasAnyRefinementContent(cleanRefinement);
  const discussionCount = issueDiscussionCount(issue, commentEvents);
  const state = triageReadinessState(readiness, hasRefinement, discussionCount);
  return {
    state,
    ready: state === 'ready',
    missing: readiness.missing,
    hasDiscussion: discussionCount > 0,
    hasRefinement,
    discussionCount,
    source: triageReadinessSource(state, readiness.missing, discussionCount),
  };
}

export function triageReadinessMoveToTodoNotice(readiness) {
  if (!readiness) {
    return '已移动到 Todo。';
  }
  if (readiness.ready) {
    return 'Triage readiness 已满足，已移动到 Todo。';
  }
  const missing = readiness.missing.length > 0
    ? `缺少：${readiness.missing.join('、')}。`
    : '';
  return `已移动到 Todo；当前 readiness 为 ${readiness.state}。${readiness.source}${missing}`;
}

export function refinementDraftToIssueRefinement(draft) {
  return normalizeRefinement({
    problem: draft?.problem,
    context: draft?.context,
    acceptanceCriteria: draft?.acceptanceCriteria ?? draft?.acceptance_criteria,
    verificationPlan: draft?.verificationPlan ?? draft?.verification_plan,
    nonGoals: draft?.nonGoals ?? draft?.non_goals,
    risks: draft?.risks ?? draft?.risksQuestions ?? draft?.risks_questions,
    recommendedProfile: draft?.recommendedProfile ?? draft?.recommended_profile,
    recommendedProvider: draft?.recommendedProvider ?? draft?.recommended_provider,
    riskLevel: draft?.riskLevel ?? draft?.risk_level,
    recommendationReasoning: draft?.recommendationReasoning ??
      draft?.recommendation_reasoning ?? draft?.whyThisProfileFits ?? draft?.why_this_profile_fits,
    needsHumanConfirmation: normalizeHumanConfirmation(
      draft?.needsHumanConfirmation ?? draft?.needs_human_confirmation
    ),
  });
}

export function deriveExecutionRecommendation({ refinement, project, profiles } = {}) {
  const cleanRefinement = normalizeRefinement(refinement);
  const hasRecommendation = REFINEMENT_RECOMMENDATION_FIELDS.some(field => cleanRefinement[field.id]);
  if (!hasRecommendation) return null;
  const warnings = recommendationWarnings(cleanRefinement, project, profiles);
  return { ...cleanRefinement, warnings, ok: warnings.length === 0 };
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
    clean[field.id] = field.id === 'needsHumanConfirmation'
      ? normalizeHumanConfirmation(refinement?.[field.id])
      : cleanText(refinement?.[field.id]);
  }
  return clean;
}

function hasAnyRefinementContent(refinement) {
  return REFINEMENT_FIELDS.some(field => refinement[field.id]);
}

function triageReadinessState(readiness, hasRefinement, discussionCount) {
  if (readiness.ready) return 'ready';
  if (hasRefinement) return 'refined';
  if (discussionCount > 0) return 'discussing';
  return 'raw';
}

function triageReadinessSource(state, missing, discussionCount) {
  if (state === 'ready') {
    return 'Refinement 已包含 Acceptance criteria 与 Verification plan。';
  }
  if (state === 'refined') {
    return `已有 refinement 内容，仍缺：${missing.join('、')}。`;
  }
  if (state === 'discussing') {
    return `已有 ${discussionCount} 条讨论，但还没有 refinement 草稿。`;
  }
  return '还没有 discussion comment 或 refinement 内容。';
}

function issueDiscussionCount(issue, commentEvents) {
  if (Array.isArray(commentEvents)) {
    return commentEvents.length;
  }
  const count = Number(issue?.comment_count ?? issue?.commentCount ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeLabel(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function recommendationWarnings(refinement, project, profiles) {
  const warnings = [];
  const provider = cleanText(refinement.recommendedProvider);
  const projectProvider = cleanText(project?.provider || 'codex').toLowerCase();
  if (provider && provider.toLowerCase() !== projectProvider) {
    warnings.push(`推荐 provider "${provider}" 当前未绑定到本项目，只能作为建议保存。`);
  }
  const profile = cleanText(refinement.recommendedProfile);
  if (profile && !matchesExistingProfile(profile, profiles)) {
    warnings.push(`推荐 profile "${profile}" 未在 Agent Profiles 中找到，只能作为建议保存。`);
  }
  return warnings;
}

function matchesExistingProfile(value, profiles) {
  const lookup = normalizeLookup(value);
  return Array.isArray(profiles) && profiles.some(profile =>
    normalizeLookup(profile?.id) === lookup || normalizeLookup(profile?.name) === lookup
  );
}

function normalizeLookup(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '');
}

function normalizeHumanConfirmation(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return cleanText(value);
}
