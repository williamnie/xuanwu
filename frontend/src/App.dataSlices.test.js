import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');

test('issues page initial reconcile only fetches issue list', () => {
  assert.match(appSource, /issues:\s*\['issues'\]/);
  assert.doesNotMatch(appSource, /issues:\s*\[[^\]]*'issueTemplates'/);
  assert.doesNotMatch(appSource, /issues:\s*\[[^\]]*'cronTasks'/);
});

test('cron page initial reconcile only fetches cron tasks', () => {
  assert.match(appSource, /cron:\s*\['cronTasks'\]/);
  assert.doesNotMatch(appSource, /cron:\s*\[[^\]]*'projects'/);
});
