import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');
const timelineSource = readFileSync(new URL('./issue-detail/IssueDetailTimeline.jsx', import.meta.url), 'utf8');
const commentsSource = readFileSync(new URL('./issue-detail/IssueDetailComments.jsx', import.meta.url), 'utf8');
const evidenceSource = readFileSync(new URL('./issue-detail/IssueDetailEvidence.jsx', import.meta.url), 'utf8');
const actionsSource = readFileSync(new URL('./issue-detail/IssueDetailActions.jsx', import.meta.url), 'utf8');
const fullSource = [source, timelineSource, commentsSource, evidenceSource, actionsSource].join('\n');

test('issue detail delegates its data flow and seven product sections to focused modules', () => {
  for (const moduleName of [
    'IssueDetailOverview',
    'IssueDetailRuns',
    'IssueDetailEvidence',
    'IssueDetailTimeline',
    'IssueDetailComments',
    'IssueDetailDecision',
    'IssueDetailActions',
    'useIssueDetailData',
    'useIssueDetailActions',
  ]) {
    assert.match(source, new RegExp(`issue-detail/${moduleName}`));
  }
  assert.ok(source.split('\n').length < 500, 'IssueDetail.jsx should remain a thin page composition root');
});

test('issue detail uses execution truth and task-oriented tabs instead of the inferred workflow sidebar', () => {
  assert.match(source, /deriveIssueExecutionSummary/);
  assert.match(timelineSource, /label="活动"/);
  assert.match(timelineSource, /label="日志"/);
  assert.match(timelineSource, /label="Runs"/);
  assert.match(timelineSource, /label="高级"/);
  assert.doesNotMatch(fullSource, /IssueWorkflowEvidencePanel/);
  assert.doesNotMatch(fullSource, /deriveIssueWorkflowEvidence/);
});

test('comments are presented as internal notes with an explicit Session handoff', () => {
  assert.match(commentsSource, /内部备注/);
  assert.match(commentsSource, /不会发送给 Agent/);
  assert.match(commentsSource, /要和 Agent 沟通？打开 Session/);
  assert.doesNotMatch(fullSource, /讨论 \/ Discussion/);
});

test('specialized panels stay conditional and destructive actions stay in the more menu', () => {
  assert.match(evidenceSource, /hasMcpRequirements\(mcpSummary\) && <IssueMcpRequirementsPanel/);
  assert.match(evidenceSource, /hasSupervisorHistory && !hasCurrentSupervisorSignal/);
  assert.match(actionsSource, /className="issue-more-menu"/);
  assert.match(actionsSource, /issue\.status !== 'in_progress'/);
});

test('issue detail explains dependency waiting with direct and root blockers', () => {
  const overviewSource = readFileSync(new URL('./issue-detail/IssueDetailOverview.jsx', import.meta.url), 'utf8');
  assert.match(overviewSource, /dependency\.direct_dependencies/);
  assert.match(overviewSource, /dependency\.root_blockers/);
  assert.match(overviewSource, /dependency\.waiting_reason/);
  assert.match(overviewSource, /relation_authority/);
});
