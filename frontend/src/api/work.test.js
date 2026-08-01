import assert from 'node:assert/strict';
import test from 'node:test';

import { workApi } from './work.js';

test('Work client exhausts every page for a large board', async () => {
  const previousFetch = globalThis.fetch;
  const requestedPages = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url, 'http://runner.local');
    const page = Number(parsed.searchParams.get('page'));
    requestedPages.push(page);
    const start = (page - 1) * 50;
    const count = page < 5 ? 50 : 5;
    return jsonResponse({
      items: Array.from({ length: count }, (_, index) => ({ id: `xw:work:issues:${start + index + 1}` })),
      page,
      page_size: 50,
      total: 205,
      total_pages: 5,
    });
  };

  try {
    const response = await workApi.getAllWorks({ projectId: 'demo' });
    assert.equal(response.items.length, 205);
    assert.deepEqual(requestedPages.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Work board client reads every lane through one bounded snapshot request', async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return jsonResponse({ lanes: {}, page_size: 20 });
  };

  try {
    await workApi.getWorkBoard({ pageSize: 20, projectId: 'demo' });
    assert.equal(requestedUrl, '/api/works/board?order=desc&page_size=20&sort=updated_at&project_id=demo');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Work detail client preserves canonical detail, timeline, actions and Issue-backed review routes', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({
      body: options.body ? JSON.parse(options.body) : null,
      method: options.method || 'GET',
      url,
    });
    return jsonResponse({ ok: true });
  };
  const workId = 'xw:work:issues:700';
  const actionPayload = { audit: { event_id: 'action-1' }, expected_revision: 7 };

  try {
    await workApi.createWork({ goal: 'Create smoke', project_id: 'demo', title: 'Created' });
    await workApi.getWork(workId);
    await workApi.getWorkTimeline(workId, { cursor: 'cursor-1', limit: 60 });
    await workApi.updateWork(workId, { title: 'Updated' });
    await workApi.controlWork(workId, 'enqueue', actionPayload);
    await workApi.controlWork(workId, 'cancel', actionPayload);
    await workApi.answerWorkHumanReview(workId, { action: 'accept', comment: '' });
    assert.deepEqual(requests, [
      {
        body: { goal: 'Create smoke', project_id: 'demo', title: 'Created' },
        method: 'POST',
        url: '/api/works',
      },
      { body: null, method: 'GET', url: '/api/works/xw%3Awork%3Aissues%3A700' },
      { body: null, method: 'GET', url: '/api/works/xw%3Awork%3Aissues%3A700/timeline?limit=60&cursor=cursor-1' },
      { body: { title: 'Updated' }, method: 'PATCH', url: '/api/works/xw%3Awork%3Aissues%3A700' },
      { body: actionPayload, method: 'POST', url: '/api/works/xw%3Awork%3Aissues%3A700/actions/enqueue' },
      { body: actionPayload, method: 'POST', url: '/api/works/xw%3Awork%3Aissues%3A700/actions/cancel' },
      { body: { action: 'accept', comment: '' }, method: 'POST', url: '/api/issues/700/human-review-response' },
    ]);
    assert.throws(() => workApi.answerWorkHumanReview('xw:work:external:700', { action: 'accept' }), /compatible Issue/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}
