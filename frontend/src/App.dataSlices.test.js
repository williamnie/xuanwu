import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');

test('legacy issues page owns its list and global reconcile only fetches bounded state', () => {
  assert.match(appSource, /issues:\s*\['projects',\s*'workSummary'\]/);
  assert.doesNotMatch(appSource, /issues:\s*\[[^\]]*'issueTemplates'/);
  assert.doesNotMatch(appSource, /issues:\s*\[[^\]]*'cronTasks'/);
});

test('Automations page only reconciles project labels because it owns Automation API loading', () => {
  assert.match(appSource, /automations:\s*\['projects'\]/);
  assert.doesNotMatch(appSource, /automations:\s*\[[^\]]*'cronTasks'/);
});

test('Dashboard uses projects and bounded Work summary', () => {
  assert.match(appSource, /'command-center':\s*\['projects',\s*'workSummary'\]/);
  assert.doesNotMatch(appSource, /dashboard:\s*\[/);
});

test('Work board reconciles project labels and bounded summary while owning lane loading', () => {
  assert.match(appSource, /work:\s*\['projects',\s*'workSummary'\]/);
  assert.doesNotMatch(appSource, /work:\s*\[[^\]]*'issues'/);
});

test('pages without global slices still settle the initial loading state on a direct route', () => {
  assert.match(appSource, /refreshData\(getReconcileSlices\(currentPage, selectedIssueId\)\)/);
  assert.doesNotMatch(appSource, /const refreshVisibleData[\s\S]*?if \(slices\.length === 0\) return;/);
});
