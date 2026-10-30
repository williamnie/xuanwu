import { readAppSource } from '../test-support/readAppSource.js';
import assert from 'node:assert/strict';

import test from 'node:test';

const appSource = readAppSource();

test('Automations page only reconciles project labels because it owns Automation API loading', () => {
  assert.match(appSource, /automations:\s*\['projects'\]/);
  assert.doesNotMatch(appSource, /automations:\s*\[[^\]]*'cronTasks'/);
});

test('Dashboard uses projects and bounded Work summary', () => {
  assert.match(appSource, /'inbox':\s*\['projects',\s*'workSummary'\]/);
  assert.doesNotMatch(appSource, /dashboard:\s*\[/);
});

test('Work board reconciles project labels and bounded summary while owning lane loading', () => {
  assert.match(appSource, /tasks:\s*\['projects',\s*'workSummary'\]/);
  assert.doesNotMatch(appSource, /tasks:\s*\[[^\]]*'issues'/);
});

test('pages without global slices still settle the initial loading state on a direct route', () => {
  assert.match(appSource, /refreshData\(getReconcileSlices\(currentPage\)\)/);
  assert.doesNotMatch(appSource, /const refreshVisibleData[\s\S]*?if \(slices\.length === 0\) return;/);
});

test('direct analytics entry loads a real Work summary before evaluating first-run onboarding', () => {
  assert.match(appSource, /analytics:\s*\['workSummary'\]/);
});
