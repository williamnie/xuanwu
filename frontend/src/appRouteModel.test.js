import assert from 'node:assert/strict';
import test from 'node:test';
import { appHashForRoute, appRouteFromHash, DEFAULT_APP_ROUTE } from './appRouteModel.js';

test('defaults to Dashboard only when the URL has no valid app route', () => {
  assert.deepEqual(appRouteFromHash(''), DEFAULT_APP_ROUTE);
  assert.deepEqual(appRouteFromHash('#/not-a-page'), DEFAULT_APP_ROUTE);
});

test('round-trips product pages and their selected entity parameters', () => {
  const routes = [
    { currentPage: 'work', selectedWorkId: 'xw:work:issues:917' },
    { currentPage: 'runs', selectedRunId: 'xw:run:issue_runs:issue-917-attempt-2' },
    { currentPage: 'runs', selectedSessionId: '019fc000-1111-7222-8333-123456789abc' },
    { currentPage: 'ask-xuanwu', selectedPiConversationId: 'pi:conversation/917' },
    { currentPage: 'settings', settingsSection: 'supervisor' },
    { currentPage: 'pi-memory' },
  ];

  for (const route of routes) {
    const parsed = appRouteFromHash(appHashForRoute(route));
    assert.equal(parsed.currentPage, route.currentPage);
    for (const [key, value] of Object.entries(route)) assert.equal(parsed[key], value);
  }
});

test('retired Connections route is not routable and Settings sections are canonical', () => {
  assert.deepEqual(appRouteFromHash('#/connections'), DEFAULT_APP_ROUTE);
  assert.equal(appHashForRoute({ currentPage: 'settings', settingsSection: 'integrations' }), '#/settings?section=integrations');
});

test('keeps existing Handoff deep links compatible', () => {
  const route = {
    currentPage: 'work',
    selectedHandoffId: 'xw:handoff:derived:917',
    selectedWorkId: 'xw:work:issues:917',
  };
  const hash = appHashForRoute(route);

  assert.equal(hash, '#/work/xw%3Awork%3Aissues%3A917/delivery/xw%3Ahandoff%3Aderived%3A917');
  assert.deepEqual(appRouteFromHash(hash), {
    ...DEFAULT_APP_ROUTE,
    currentPage: 'work',
    selectedHandoffId: route.selectedHandoffId,
    selectedWorkId: route.selectedWorkId,
  });
});

test('keeps existing plain Work deep links compatible', () => {
  assert.deepEqual(appRouteFromHash('#/work/xw%3Awork%3Aissues%3A917'), {
    ...DEFAULT_APP_ROUTE,
    currentPage: 'work',
    selectedWorkId: 'xw:work:issues:917',
  });
});

test('preserves legacy route redirects and issue filters when Work board is disabled', () => {
  assert.deepEqual(
    appRouteFromHash('#/issues?issueId=42&project=demo&focus=active', { workBoardEnabled: false }),
    {
      ...DEFAULT_APP_ROUTE,
      currentPage: 'issues',
      filterProject: 'demo',
      focusFilter: 'active',
      selectedIssueId: 42,
    },
  );
  assert.deepEqual(appRouteFromHash('#/issues?issueId=42'), {
    ...DEFAULT_APP_ROUTE,
    currentPage: 'work',
    selectedWorkId: 'xw:work:issues:42',
  });
  assert.deepEqual(appRouteFromHash('#/sessions?sessionId=provider-session'), {
    ...DEFAULT_APP_ROUTE,
    currentPage: 'runs',
    selectedSessionId: 'provider-session',
  });
});

test('prefers runId over sessionId when both are present', () => {
  assert.deepEqual(
    appRouteFromHash('#/runs?runId=run-2&sessionId=session-1'),
    {
      ...DEFAULT_APP_ROUTE,
      currentPage: 'runs',
      selectedRunId: 'run-2',
    },
  );
});

test('Work deep links can select one Run without leaving Work Detail', () => {
  const route = appRouteFromHash('#/work?workId=xw%3Awork%3Aissues%3A2&runId=xw%3Arun%3Aissue_runs%3Aissue-2-attempt-1');
  assert.equal(route.currentPage, 'work');
  assert.equal(route.selectedWorkId, 'xw:work:issues:2');
  assert.equal(route.selectedRunId, 'xw:run:issue_runs:issue-2-attempt-1');
  assert.equal(appHashForRoute(route), '#/work?workId=xw%3Awork%3Aissues%3A2&runId=xw%3Arun%3Aissue_runs%3Aissue-2-attempt-1');
  assert.equal(appRouteFromHash('#/work?runId=orphan').selectedRunId, '');
});

test('Task list links can open a specific scope', () => {
  assert.equal(appRouteFromHash('#/work?scope=attention').taskScope, 'attention');
  assert.equal(appRouteFromHash('#/work?scope=bogus').taskScope, '');
  assert.equal(appHashForRoute({ currentPage: 'work', taskScope: 'attention' }), '#/work?scope=attention');
  assert.equal(appHashForRoute({ currentPage: 'work', selectedWorkId: 'xw:work:issues:1', taskScope: 'attention' }), '#/work?workId=xw%3Awork%3Aissues%3A1');
});


test('project task links round-trip encoded filters with scopes and legacy redirects', () => {
  const route = { currentPage: 'work', filterProject: '玄武 & demo/1', taskScope: 'all' };
  const parsed = appRouteFromHash(appHashForRoute(route));
  assert.equal(parsed.filterProject, route.filterProject);
  assert.equal(parsed.taskScope, 'all');
  assert.equal(appRouteFromHash('#/issues?project=demo').filterProject, 'demo');
  assert.equal(appRouteFromHash('#/work?project=').filterProject, '');
  assert.equal(appHashForRoute({ ...route, filterProject: '' }), '#/work?scope=all');
  assert.equal(appRouteFromHash('#/settings?project=demo').filterProject, '');
});
