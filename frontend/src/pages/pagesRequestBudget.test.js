import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sessionsSource = readFileSync(new URL('./Sessions.jsx', import.meta.url), 'utf8');
const issueDetailSource = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');
const projectsSource = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const templatesSource = readFileSync(new URL('./IssueTemplatesPanel.jsx', import.meta.url), 'utf8');

test('sessions page initial store refresh does not fetch global issue list or capabilities', () => {
  assert.match(sessionsSource, /refreshData\(\['projects'\]\)/);
  assert.doesNotMatch(sessionsSource, /refreshData\(\['projects', 'issues'\]\)/);
  assert.doesNotMatch(sessionsSource, /api\.getCapabilities\(\)/);
});

test('issue detail uses parallel detail reads and only loads profiles on first load', () => {
  assert.match(issueDetailSource, /Promise\.all\(/);
  assert.match(issueDetailSource, /loadIssueData\(\{ includeProfiles: true \}\)/);
  assert.match(issueDetailSource, /includeProfiles\s*\?\s*readOptional\(\(\) => api\.getAgentProfiles\(\)/);
});

test('project and template writes avoid refreshAllData fan-out', () => {
  assert.doesNotMatch(projectsSource, /refreshAllData/);
  assert.doesNotMatch(templatesSource, /refreshAllData/);
  assert.match(projectsSource, /refreshData\(\['projects', 'issues'\]\)/);
  assert.match(templatesSource, /refreshData\(\['issueTemplates'\]\)/);
});
