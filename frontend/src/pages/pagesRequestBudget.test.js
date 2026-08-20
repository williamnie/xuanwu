import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sessionsSource = readFileSync(new URL('./Sessions.jsx', import.meta.url), 'utf8');
const issueDetailDataSource = readFileSync(new URL('./issue-detail/useIssueDetailData.js', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('./Dashboard.jsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const projectsSource = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const runsSource = readFileSync(new URL('./Runs.jsx', import.meta.url), 'utf8');
const activeWorkSource = readFileSync(new URL('./command-center/ActiveWorkSection.jsx', import.meta.url), 'utf8');
const recentDeliveriesSource = readFileSync(new URL('./command-center/RecentDeliveriesSection.jsx', import.meta.url), 'utf8');
const firstDeliverySource = readFileSync(new URL('./command-center/FirstDeliveryGuide.jsx', import.meta.url), 'utf8');
const usageSource = readFileSync(new URL('../components/CodexUsagePanel.jsx', import.meta.url), 'utf8');

test('sessions page initial store refresh does not fetch global issue list or capabilities', () => {
  assert.match(sessionsSource, /refreshData\(\['projects'\]\)/);
  assert.doesNotMatch(sessionsSource, /refreshData\(\['projects', 'issues'\]\)/);
  assert.doesNotMatch(sessionsSource, /systemApi\.getCapabilities\(\)/);
});

test('issue detail uses parallel detail reads and only loads profiles on first load', () => {
  assert.match(issueDetailDataSource, /Promise\.all\(/);
  assert.match(issueDetailDataSource, /loadIssueData\(\{ includeProfiles: true \}\)/);
  assert.match(issueDetailDataSource, /includeProfiles\s*\?\s*readOptional\(\(\) => projectsApi\.getAgentProfiles\(\)/);
});

test('issue detail excludes logs from initial reads and loads a bounded log page on demand', () => {
  assert.match(issueDetailDataSource, /workApi\.getIssueEventSummaries\(issueId,\s*\{ excludeTypes: \['issue\.log'\] \}\)/);
  assert.match(issueDetailDataSource, /types: \['issue\.log'\]/);
  assert.match(issueDetailDataSource, /limit: LOG_PAGE_SIZE/);
  assert.match(issueDetailDataSource, /activeTab !== 'logs'/);
});

test('dashboard hydrates bounded persisted activity from the event summary projection', () => {
  assert.match(dashboardSource, /eventsApi\.getEventSummaries\(\{ limit: 20 \}\)/);
  assert.match(dashboardSource, /subscribeToEvents/);
});

test('selected issue detail does not reconcile the global issue list', () => {
  assert.match(appSource, /currentPage === 'issues' && selectedIssueId\) return \[\]/);
  assert.doesNotMatch(appSource, /currentPage === 'issues' && selectedIssueId\) return \['issues'\]/);
});

test('project writes avoid refreshAllData fan-out', () => {
  assert.doesNotMatch(projectsSource, /refreshAllData/);
  assert.match(projectsSource, /refreshData\(\['projects', 'workSummary'\]\)/);
});

test('production read paths have no all-pages Work helper or global Issue store slice', () => {
  const workApiSource = readFileSync(new URL('../api/work.js', import.meta.url), 'utf8');
  const dataStoreSource = readFileSync(new URL('../store/dataStore.js', import.meta.url), 'utf8');
  assert.doesNotMatch(workApiSource, /getAllWorks|function allPages/);
  assert.doesNotMatch(dataStoreSource, /workApi\.getIssues\(\)/);
  assert.doesNotMatch(dataStoreSource, /\bissues:\s*\[\]/);
});

test('Runs coalesces lifecycle refreshes, aborts stale reads, and loads detail only after selection', () => {
  assert.match(runsSource, /if \(listRequest\.current\)[\s\S]*await listRequest\.current\.catch/);
  assert.match(runsSource, /signal: controller\.signal/);
  assert.match(runsSource, /window\.setTimeout/);
  assert.doesNotMatch(runsSource, /window\.setInterval/);
  assert.doesNotMatch(runsSource, /runs\[0\]\?\.id\) setActiveRunId/);
  assert.match(runsSource, /silent \? mergeRunPages\(firstPage, current\) : firstPage/);
});

test('Dashboard trusts bounded summaries instead of hydrating every card detail', () => {
  assert.doesNotMatch(activeWorkSource, /hydrateRunDetails/);
  assert.doesNotMatch(recentDeliveriesSource, /hydrateDeliveryStatuses|handoffsApi\.getHandoff/);
  assert.match(recentDeliveriesSource, /if \(!visible\) return undefined/);
  assert.match(recentDeliveriesSource, /setVisible\(true\)/);
  assert.match(usageSource, /getProviderUsage\(\{ compact: true, refresh: true \}\)/);
  assert.match(usageSource, /Promise\.all\(/);
  assert.match(usageSource, /useEffect/);
  assert.doesNotMatch(usageSource, /setInterval/);
});

test('first delivery onboarding uses bounded Work and Evidence reads', () => {
  assert.match(firstDeliverySource, /workApi\.getWorks\(\{ pageSize: 8 \}/);
  assert.match(firstDeliverySource, /systemApi\.getCodeAgents\(\)/);
  assert.doesNotMatch(firstDeliverySource, /workApi\.getAllWorks\(\)/);
  assert.doesNotMatch(firstDeliverySource, /Promise\.allSettled/);
  assert.match(firstDeliverySource, /candidateWorkID/);
});
