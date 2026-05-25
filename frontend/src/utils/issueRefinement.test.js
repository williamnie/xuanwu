import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueRefinementReadiness,
  parseIssueRefinement,
  refinementDraftToIssueRefinement,
  serializeIssueRefinement,
} from './issueRefinement.js';

test('refinement draft maps API fields into editable refinement fields', () => {
  assert.deepEqual(refinementDraftToIssueRefinement({
    problem: '  当前问题  ',
    context: 'frontend/src/pages/IssueDetail.jsx',
    acceptanceCriteria: '- 可以生成草稿',
    verificationPlan: '- npm --prefix frontend run build',
    nonGoals: '不自动 todo',
    risks: '需要用户确认',
  }), {
    problem: '当前问题',
    context: 'frontend/src/pages/IssueDetail.jsx',
    acceptanceCriteria: '- 可以生成草稿',
    verificationPlan: '- npm --prefix frontend run build',
    nonGoals: '不自动 todo',
    risks: '需要用户确认',
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
