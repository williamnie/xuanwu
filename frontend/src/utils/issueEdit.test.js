import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canEditIssue,
  issueDraftToPatch,
  issueToEditDraft,
  validateIssueDraft,
} from './issueEdit.js';

test('triage issue can enter edit mode', () => {
  assert.equal(canEditIssue({ status: 'triage' }), true);
});

test('non-triage issue cannot enter edit mode', () => {
  for (const status of ['todo', 'in_progress', 'failed', 'done', 'cancelled']) {
    assert.equal(canEditIssue({ status }), false);
  }
});

test('issue edit draft keeps editable fields only', () => {
  assert.deepEqual(issueToEditDraft({
    project_id: 'runner',
    title: '修正文案',
    description: '  旧内容  ',
    priority: 2,
    status: 'triage',
  }), {
    agent_profile_id: '',
    project_id: 'runner',
    title: '修正文案',
    description: '  旧内容  ',
    priority: '2',
  });
});

test('issue edit patch trims text and normalizes priority', () => {
  assert.deepEqual(issueDraftToPatch({
    agent_profile_id: '  qoder-review  ',
    project_id: '  runner  ',
    title: '  新标题  ',
    description: '  新内容  ',
    priority: 'bad',
  }), {
    agent_profile_id: 'qoder-review',
    project_id: 'runner',
    title: '新标题',
    description: '新内容',
    priority: 0,
  });
});

test('blank issue description is rejected before saving', () => {
  assert.equal(validateIssueDraft({ project_id: 'runner', description: '   ' }), '任务内容不能为空');
});

test('missing target project is rejected before saving', () => {
  assert.equal(validateIssueDraft({ project_id: '   ', description: '有效内容' }), '请选择关联目标项目');
});
