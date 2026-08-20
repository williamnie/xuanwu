import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedSummaryFetcher } from './summaryRefreshCoordinator.js';

test('Work summary refresh burst has one leading and at most one trailing request', async () => {
  let requests = 0;
  const refresh = boundedSummaryFetcher(async () => {
    requests += 1;
    return { request: requests };
  });

  await refresh();
  const burst = Array.from({ length: 100 }, () => refresh());
  const results = await Promise.all(burst);

  assert.equal(requests, 2);
  assert.ok(results.every(result => result.request === 2));
});
