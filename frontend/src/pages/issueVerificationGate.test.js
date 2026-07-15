import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const issuesPage = readFileSync(new URL('./Issues.jsx', import.meta.url), 'utf8');
const detailPage = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');
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
  assert.match(detailPage, /handleVerificationReview\('accept', ''\)/);
  assert.match(detailPage, /setVerificationReviewAction\('reject'\)/);
  assert.match(detailPage, /setVerificationReviewAction\('request_changes'\)/);
  assert.match(detailPage, /function VerificationReviewModal/);
  assert.match(detailPage, /VerifierReportPanel/);
  assert.match(detailPage, /issue\.verification_report/);
  assert.doesNotMatch(detailPage, /window\.prompt/);
});

test('triage to todo avoids native confirm gates', () => {
  assert.doesNotMatch(issuesPage, /window\.confirm/);
  assert.doesNotMatch(detailPage, /window\.confirm/);
  assert.doesNotMatch(detailPage, /confirmTriageReady/);
});

test('dragging to in progress starts runner execution instead of raw status patch', () => {
  assert.match(issuesPage, /moveIssueAfterDrop/);
  assert.match(issuesPage, /await moveIssueAfterDrop\(issueId,\s*targetStatus\)/);
  assert.match(issuesPage, /targetStatus === 'in_progress'[\s\S]*workApi\.enqueueIssue\(issueId\)/);
});
