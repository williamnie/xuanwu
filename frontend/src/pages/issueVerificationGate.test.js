import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const issuesPage = readFileSync(new URL('./Issues.jsx', import.meta.url), 'utf8');
const detailPage = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');
const detailActions = readFileSync(new URL('./issue-detail/useIssueDetailActions.js', import.meta.url), 'utf8');
const detailVerification = readFileSync(new URL('./issue-detail/IssueDetailVerification.jsx', import.meta.url), 'utf8');
const detailTimeline = readFileSync(new URL('./issue-detail/IssueDetailTimeline.jsx', import.meta.url), 'utf8');
const detailSource = [detailPage, detailActions, detailVerification, detailTimeline].join('\n');
const workClient = readFileSync(new URL('../api/work.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('issues board does not expose pending verification as its own column', () => {
  assert.doesNotMatch(issuesPage, /pendingVerificationIssues/);
  assert.doesNotMatch(issuesPage, /id:\s*'pending_verification'/);
  assert.doesNotMatch(issuesPage, /title:\s*'Pending Verification'/);
  assert.doesNotMatch(css, /\.status-badge\.pending_verification/);
});

test('issue detail provides pending verification review actions', () => {
  assert.match(workClient, /reviewIssueVerification:/);
  assert.match(workClient, /generateIssueVerifierReport:/);
  assert.match(detailPage, /issue\.status === 'pending_verification'/);
  assert.match(detailPage, /setVerificationReviewAction\('accept'\)/);
  assert.match(detailVerification, /PI 正在自主验收/);
  assert.match(detailVerification, /PI 验收已排队/);
  assert.match(detailVerification, /PI 正在补齐验收证据/);
  assert.match(detailVerification, /PI 验收遇到问题/);
  assert.match(detailVerification, /verification\?\.activity\?\.error/);
  assert.match(detailVerification, /继续同一 Session/);
  assert.match(detailPage, /setVerificationReviewAction\('reject'\)/);
  assert.match(detailPage, /setVerificationReviewAction\('request_changes'\)/);
  assert.match(detailVerification, /function VerificationReviewModal/);
  assert.match(detailPage, /VerifierReportPanel/);
  assert.match(detailTimeline, /issue\.verification_report/);
  assert.doesNotMatch(detailSource, /window\.prompt/);
});

test('triage to todo avoids native confirm gates', () => {
  assert.doesNotMatch(issuesPage, /window\.confirm/);
  assert.doesNotMatch(detailSource, /window\.confirm/);
  assert.doesNotMatch(detailSource, /confirmTriageReady/);
});

test('dragging to in progress starts runner execution instead of raw status patch', () => {
  assert.match(issuesPage, /moveIssueAfterDrop/);
  assert.match(issuesPage, /await moveIssueAfterDrop\(issueId,\s*currentStatus,\s*targetStatus\)/);
  assert.match(issuesPage, /targetStatus === 'in_progress'[\s\S]*workApi\.enqueueIssue\(issueId\)/);
});

test('dragging a running issue back to todo uses interrupt-aware retry', () => {
  assert.match(
    issuesPage,
    /currentStatus === 'in_progress' && targetStatus === 'todo'[\s\S]*workApi\.retryIssue\(issueId\)/,
  );
});
