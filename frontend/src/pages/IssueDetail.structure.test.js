import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');

test('issue detail uses execution truth and task-oriented tabs instead of the inferred workflow sidebar', () => {
  assert.match(source, /deriveIssueExecutionSummary/);
  assert.match(source, /label="活动"/);
  assert.match(source, /label="日志"/);
  assert.match(source, /label="Runs"/);
  assert.match(source, /label="高级"/);
  assert.doesNotMatch(source, /IssueWorkflowEvidencePanel/);
  assert.doesNotMatch(source, /deriveIssueWorkflowEvidence/);
});

test('comments are presented as internal notes with an explicit Session handoff', () => {
  assert.match(source, /内部备注/);
  assert.match(source, /不会发送给 Agent/);
  assert.match(source, /要和 Agent 沟通？打开 Session/);
  assert.doesNotMatch(source, /讨论 \/ Discussion/);
});

test('specialized panels stay conditional and destructive actions stay in the more menu', () => {
  assert.match(source, /hasMcpRequirements\(mcpSummary\) && <IssueMcpRequirementsPanel/);
  assert.match(source, /hasCurrentSupervisorSignal && <IssueSupervisorPanel/);
  assert.match(source, /className="issue-more-menu"/);
  assert.match(source, /issue\.status !== 'in_progress'/);
});
