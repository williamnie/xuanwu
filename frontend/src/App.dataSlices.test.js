import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');

test('issues page initial reconcile only fetches issue list', () => {
  assert.match(appSource, /issues:\s*\['issues'\]/);
  assert.doesNotMatch(appSource, /issues:\s*\[[^\]]*'issueTemplates'/);
  assert.doesNotMatch(appSource, /issues:\s*\[[^\]]*'cronTasks'/);
});

test('Automations page initial reconcile only fetches compatibility cron tasks', () => {
  assert.match(appSource, /automations:\s*\['cronTasks'\]/);
  assert.doesNotMatch(appSource, /automations:\s*\[[^\]]*'projects'/);
});

test('Command Center keeps the existing bounded dashboard data slices', () => {
  assert.match(appSource, /'command-center':\s*\['projects',\s*'issues'\]/);
  assert.doesNotMatch(appSource, /dashboard:\s*\[/);
});

test('Work board only reconciles project labels because it owns Work API loading', () => {
  assert.match(appSource, /work:\s*\['projects'\]/);
  assert.doesNotMatch(appSource, /work:\s*\[[^\]]*'issues'/);
});
