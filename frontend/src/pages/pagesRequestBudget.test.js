import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sessionsSource = readFileSync(new URL('./Sessions.jsx', import.meta.url), 'utf8');
const issueDetailSource = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('./Dashboard.jsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const projectsSource = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const templatesSource = readFileSync(new URL('./IssueTemplatesPanel.jsx', import.meta.url), 'utf8');

test('sessions page initial store refresh does not fetch global issue list or capabilities', () => {
  assert.match(sessionsSource, /refreshData\(\['projects'\]\)/);
  assert.doesNotMatch(sessionsSource, /refreshData\(\['projects', 'issues'\]\)/);
  assert.doesNotMatch(sessionsSource, /systemApi\.getCapabilities\(\)/);
});

test('issue detail uses parallel detail reads and only loads profiles on first load', () => {
  assert.match(issueDetailSource, /Promise\.all\(/);
  assert.match(issueDetailSource, /loadIssueData\(\{ includeProfiles: true \}\)/);
  assert.match(issueDetailSource, /includeProfiles\s*\?\s*readOptional\(\(\) => projectsApi\.getAgentProfiles\(\)/);
});

test('issue detail excludes logs from initial reads and loads a bounded log page on demand', () => {
  assert.match(issueDetailSource, /workApi\.getIssueEventSummaries\(issueId,\s*\{ excludeTypes: \['issue\.log'\] \}\)/);
  assert.match(issueDetailSource, /types: \['issue\.log'\]/);
  assert.match(issueDetailSource, /limit: LOG_PAGE_SIZE/);
  assert.match(issueDetailSource, /activeTab !== 'logs'/);
});

test('dashboard hydrates bounded persisted activity from the event summary projection', () => {
  assert.match(dashboardSource, /eventsApi\.getEventSummaries\(\{ limit: 20 \}\)/);
  assert.match(dashboardSource, /subscribeToEvents/);
});

test('selected issue detail does not reconcile the global issue list', () => {
  assert.match(appSource, /currentPage === 'issues' && selectedIssueId\) return \[\]/);
  assert.doesNotMatch(appSource, /currentPage === 'issues' && selectedIssueId\) return \['issues'\]/);
});

test('project and template writes avoid refreshAllData fan-out', () => {
  assert.doesNotMatch(projectsSource, /refreshAllData/);
  assert.doesNotMatch(templatesSource, /refreshAllData/);
  assert.match(projectsSource, /refreshData\(\['projects', 'issues'\]\)/);
  assert.match(templatesSource, /refreshData\(\['issueTemplates'\]\)/);
});
