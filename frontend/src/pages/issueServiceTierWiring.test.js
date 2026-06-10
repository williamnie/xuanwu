import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const projectsSource = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const issuesSource = readFileSync(new URL('./Issues.jsx', import.meta.url), 'utf8');
const issueCardSource = readFileSync(new URL('./IssueCard.jsx', import.meta.url), 'utf8');
const issueDetailSource = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');

test('projects and agent profiles expose service tier settings', () => {
  assert.match(projectsSource, /formServiceTier/);
  assert.match(projectsSource, /default_service_tier:\s*formServiceTier/);
  assert.match(projectsSource, /onFieldChange\('service_tier'/);
  assert.match(projectsSource, /serviceTierLabel\(proj\.default_service_tier\)/);
});

test('issue cards persist service tier overrides and retry with the selected tier', () => {
  assert.match(issuesSource, /handleIssueServiceTierChange/);
  assert.match(issuesSource, /api\.updateIssue\(issueId,\s*serviceTierPayload\(serviceTier\)\)/);
  assert.match(issuesSource, /api\.retryIssue\(issueId,\s*serviceTierPayload\(issue\?\.service_tier\)\)/);
  assert.match(issueCardSource, /onServiceTierChange/);
  assert.match(issueCardSource, /serviceTierOptions\(issue\.service_tier\)/);
});

test('issue detail can change next-run speed and displays run snapshots', () => {
  assert.match(issueDetailSource, /handleServiceTierChange/);
  assert.match(issueDetailSource, /api\.retryIssue\(issueId,\s*serviceTierPayload\(issue\.service_tier\)\)/);
  assert.match(issueDetailSource, /RunField label="Speed"/);
  assert.match(issueDetailSource, /serviceTierRunLabel\(run\)/);
});
