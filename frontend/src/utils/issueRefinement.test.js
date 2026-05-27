import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveExecutionRecommendation,
  deriveTriageReadiness,
  issueRefinementReadiness,
  parseIssueRefinement,
  refinementDraftToIssueRefinement,
  serializeIssueRefinement,
  triageReadinessMoveToTodoNotice,
} from './issueRefinement.js';

test('refinement draft maps API fields into editable refinement fields', () => {
  assert.deepEqual(refinementDraftToIssueRefinement({
    problem: '  当前问题  ',
    context: 'frontend/src/pages/IssueDetail.jsx',
    acceptanceCriteria: '- 可以生成草稿',
    verificationPlan: '- npm --prefix frontend run build',
    nonGoals: '不自动 todo',
    risks: '需要用户确认',
    recommendedProfile: 'codex-dev',
    recommendedProvider: 'codex',
    riskLevel: 'Medium',
    recommendationReasoning: 'Codex 已是生产执行 provider',
    needsHumanConfirmation: true,
  }), {
    problem: '当前问题',
    context: 'frontend/src/pages/IssueDetail.jsx',
    acceptanceCriteria: '- 可以生成草稿',
    verificationPlan: '- npm --prefix frontend run build',
    nonGoals: '不自动 todo',
    risks: '需要用户确认',
    recommendedProfile: 'codex-dev',
    recommendedProvider: 'codex',
    riskLevel: 'Medium',
    recommendationReasoning: 'Codex 已是生产执行 provider',
    needsHumanConfirmation: 'Yes',
  });
});

test('saved generated refinement block remains ready for move-to-todo check', () => {
  const description = serializeIssueRefinement('原始描述', refinementDraftToIssueRefinement({
    acceptanceCriteria: '- 包含验收标准',
    verificationPlan: '- 最小验证步骤',
  }));
  const parsed = parseIssueRefinement(description);

  assert.equal(parsed.body, '原始描述');
  assert.equal(issueRefinementReadiness(parsed.refinement).ready, true);
});

test('refinement block preserves execution recommendation fields', () => {
  const description = serializeIssueRefinement('原始描述', {
    recommendedProfile: 'readonly-verifier',
    recommendedProvider: 'codex',
    riskLevel: 'Low',
    recommendationReasoning: '- 只读验证更合适',
    needsHumanConfirmation: 'Yes',
  });
  const parsed = parseIssueRefinement(description);

  assert.equal(parsed.refinement.recommendedProfile, 'readonly-verifier');
  assert.equal(parsed.refinement.recommendationReasoning, '- 只读验证更合适');
});

test('execution recommendation warns for unavailable profile or provider', () => {
  const recommendation = deriveExecutionRecommendation({
    refinement: {
      recommendedProfile: 'claude-review',
      recommendedProvider: 'Claude Code',
      riskLevel: 'High',
      recommendationReasoning: '适合 code review',
      needsHumanConfirmation: 'Yes',
    },
    project: { provider: 'codex' },
    profiles: [{ id: 'codex-dev', name: 'Codex Dev' }],
  });

  assert.equal(recommendation.ok, false);
  assert.equal(recommendation.warnings.length, 2);
});

test('execution recommendation accepts configured project provider and profile', () => {
  const recommendation = deriveExecutionRecommendation({
    refinement: {
      recommendedProfile: 'Codex Dev',
      recommendedProvider: 'codex',
      riskLevel: 'Medium',
      recommendationReasoning: '默认执行画像匹配',
      needsHumanConfirmation: 'Yes',
    },
    project: { provider: 'codex' },
    profiles: [{ id: 'codex-dev', name: 'Codex Dev' }],
  });

  assert.equal(recommendation.ok, true);
  assert.deepEqual(recommendation.warnings, []);
});

test('triage readiness derives raw from issue without discussion or refinement', () => {
  const readiness = deriveTriageReadiness({ issue: { status: 'triage', description: '随手记录' } });

  assert.equal(readiness.state, 'raw');
  assert.equal(readiness.ready, false);
});

test('triage readiness derives discussing from comment-only issue', () => {
  const readiness = deriveTriageReadiness({
    issue: { status: 'triage', description: '待澄清', comment_count: 1 },
  });

  assert.equal(readiness.state, 'discussing');
  assert.equal(readiness.ready, false);
});

test('triage readiness derives refined from incomplete refinement content', () => {
  const description = serializeIssueRefinement('原始描述', { problem: '已有问题描述' });
  const readiness = deriveTriageReadiness({ issue: { status: 'triage', description } });

  assert.equal(readiness.state, 'refined');
  assert.deepEqual(readiness.missing, ['Acceptance criteria', 'Verification plan']);
});

test('triage readiness derives ready from acceptance criteria and verification plan', () => {
  const description = serializeIssueRefinement('原始描述', {
    acceptanceCriteria: '- 可验收结果',
    verificationPlan: '- node --test',
  });
  const readiness = deriveTriageReadiness({ issue: { status: 'triage', description } });

  assert.equal(readiness.state, 'ready');
  assert.equal(readiness.ready, true);
});

test('triage readiness is not shown for non-triage issues', () => {
  const readiness = deriveTriageReadiness({
    issue: { status: 'todo', description: '已进入执行队列', comment_count: 1 },
  });

  assert.equal(readiness, null);
});

test('triage move-to-todo notice explains gaps without asking for confirmation', () => {
  const readiness = deriveTriageReadiness({ issue: { status: 'triage', description: '随手记录' } });
  const notice = triageReadinessMoveToTodoNotice(readiness);

  assert.match(notice, /已移动到 Todo/);
  assert.match(notice, /readiness 为 raw/);
  assert.doesNotMatch(notice, /仍要|确认|\?/);
});
