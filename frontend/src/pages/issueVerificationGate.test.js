import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const issuesPage = readFileSync(new URL('./Issues.jsx', import.meta.url), 'utf8');
const detailPage = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');
const apiClient = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('issues board exposes pending verification as its own column', () => {
  assert.match(issuesPage, /pendingVerificationIssues\s*=\s*projectIssues\.filter\(i => i\.status === 'pending_verification'\)/);
  assert.match(issuesPage, /id:\s*'pending_verification'/);
  assert.match(issuesPage, /title:\s*'Pending Verification'/);
  assert.match(css, /\.status-badge\.pending_verification/);
});

test('issue detail provides pending verification review actions', () => {
  assert.match(apiClient, /reviewIssueVerification:/);
  assert.match(detailPage, /issue\.status === 'pending_verification'/);
  assert.match(detailPage, /handleVerificationReview\('accept'\)/);
  assert.match(detailPage, /handleVerificationReview\('reject'\)/);
  assert.match(detailPage, /handleVerificationReview\('request_changes'\)/);
});

test('triage to todo uses non-blocking readiness notice instead of native confirm', () => {
  assert.match(issuesPage, /moveToTodoReadinessNotice/);
  assert.match(detailPage, /moveToTodoReadinessNotice/);
  assert.doesNotMatch(issuesPage, /window\.confirm/);
  assert.doesNotMatch(detailPage, /triageReadinessMoveToTodoMessage/);
  assert.doesNotMatch(detailPage, /confirmTriageReady/);
});
