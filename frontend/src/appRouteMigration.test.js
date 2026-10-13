import test from 'node:test';
import assert from 'node:assert/strict';
import { appRouteFromHash, appHashForRoute } from './appRouteModel.js';
import { resolveSettingsRoute } from './pages/settingsNavigation.js';
test('canonical inbox/tasks and old links retain all task list context', () => {
  for (const prefix of ['work', 'tasks']) {
    const route = appRouteFromHash(`#/${prefix}?workId=xw%3Awork%3Aissues%3A9&runId=r2&sessionId=s1&project=demo&focus=failed&query=hello&source=github&view=board`);
    assert.equal(route.currentPage, 'tasks');assert.equal(route.selectedWorkId, 'xw:work:issues:9');assert.equal(route.selectedRunId, 'r2');assert.equal(route.selectedSessionId, '');
    assert.equal(route.filterProject, 'demo');assert.equal(route.focusFilter, 'failed');assert.equal(route.taskQuery, 'hello');assert.equal(route.taskSource, 'github');assert.equal(route.taskView, 'board');
    assert.deepEqual(appRouteFromHash(appHashForRoute(route)), route);
  }
  assert.equal(appRouteFromHash('#/command-center').currentPage, 'inbox');
  assert.equal(appRouteFromHash('#/inbox').currentPage, 'inbox');
  assert.equal(appRouteFromHash('#/automations').taskSubview, 'automations');
});
test('legacy Issue/Handoff, flags and separate Run/Session fallback retain identity', () => {
  assert.equal(appRouteFromHash('#/issues?issueId=9&project=p&focus=triage').selectedWorkId, 'xw:work:issues:9');
  for (const prefix of ['work', 'tasks']) {
    const link = `#/${prefix}/xw%3Awork%3Aissues%3A9/delivery/xw%3Ahandoff%3Aderived%3A9`;
    assert.equal(appRouteFromHash(link).currentPage, 'tasks');
    const fallback = appRouteFromHash(link, { workBoardEnabled: false });
    assert.equal(fallback.currentPage, 'handoffs');assert.equal(fallback.selectedHandoffId, 'xw:handoff:derived:9');
  }
  assert.equal(appRouteFromHash('#/tasks?workId=xw%3Awork%3Aissues%3A9', { workBoardEnabled: false }).selectedIssueId, 9);
  assert.equal(appRouteFromHash('#/runs?runId=unknown&sessionId=another').selectedSessionId, '');
  assert.equal(appRouteFromHash('#/sessions?sessionId=orphan').selectedSessionId, 'orphan');
});
test('conversation and bare/prefixed settings links survive serialization', () => {
  const conversation = appRouteFromHash('#/pi-chat?conversationId=a%2Fb');
  assert.equal(conversation.selectedPiConversationId, 'a/b');assert.deepEqual(appRouteFromHash(appHashForRoute(conversation)), conversation);
  for (const section of ['memory', 'advanced/memory', 'skills', 'advanced/skills', 'code-agents', 'ai/code-agents']) {
    const route = appRouteFromHash(`#/settings?section=${encodeURIComponent(section)}`);
    assert.equal(route.settingsSection, section);assert.ok(resolveSettingsRoute(section));
    assert.deepEqual(appRouteFromHash(appHashForRoute(route)), route);
  }
});
