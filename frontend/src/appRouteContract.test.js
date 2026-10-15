import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { appHashForRoute, appRouteFromHash } from './appRouteModel.js';
import { resolveSettingsRoute } from './pages/settingsNavigation.js';

// Frozen before D4: only append new canonical IDs here; keep all legacy inputs
// and object/state assertions below unchanged throughout the migration.
const PAGE_IDS = { inbox: ['command-center', 'inbox'], tasks: ['work', 'tasks'] };
const workId = 'xw:work:issues:42';
const handoffId = 'xw:handoff:derived:42';
const runId = 'xw:run:issue_runs:issue-42-attempt-2';
const workPath = `#/work/${encodeURIComponent(workId)}`;
const deliveryPath = `${workPath}/delivery/${encodeURIComponent(handoffId)}`;
const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');

function assertPage(route, page) {
  assert.ok((PAGE_IDS[page] || [page]).includes(route.currentPage), `${route.currentPage} must remain the ${page} surface`);
}

function browserHistory(initialHash) {
  const entries = [initialHash];
  let index = 0;
  const location = { pathname: '/', search: '', hash: initialHash };
  const listeners = {};
  const state = { ...appRouteFromHash(initialHash), pageContext: null };
  const history = {
    pushState(_state, _title, href) { entries.splice(++index); entries.push(href.slice(href.indexOf('#'))); location.hash = entries[index]; },
    replaceState(_state, _title, href) { entries[index] = href.slice(href.indexOf('#')); location.hash = entries[index]; },
  };
  const context = {
    location, history, appRouteFromHash, appHashForRoute, WORK_BOARD_ENABLED: true,
    addEventListener: (name, handler) => { listeners[name] = handler; },
    removeEventListener: name => { delete listeners[name]; },
    startPageTransition: callback => callback(), updateAppState: callback => callback(state),
    setMobileSidebarOpen: () => {},
  };
  // eslint-disable-next-line no-regex-spaces -- Match the frozen source indentation literally.
  const effect = appSource.match(/useEffect\(\(\) => \{\n    if \(!globalThis.addEventListener\)([\s\S]*?)\n  \}, \[updateAppState\]\);/);
  assert.ok(effect, 'browser history must keep the live App synchronization effect');
  runInNewContext(`(() => { if (!globalThis.addEventListener)${effect[1]} })()`, context);
  // eslint-disable-next-line no-regex-spaces -- Match the frozen source indentation literally.
  const writer = appSource.match(/const writeBrowserRoute = useCallback\(\((route, \{ replace = false \} = \{\})\) => \{([\s\S]*?)\n  \}, \[\]\);/);
  assert.ok(writer, 'history writes must use the live App callback');
  const write = runInNewContext(`(${writer[1]}) => {${writer[2]}\n}`, context);
  return {
    state,
    hash: () => location.hash,
    visit(hash) { history.pushState(null, '', hash); listeners.hashchange(); },
    back() { location.hash = entries[--index]; listeners.popstate(); },
    forward() { location.hash = entries[++index]; listeners.popstate(); },
    write,
  };
}

test('D4 baseline 1: legacy Work, issue conversion and both Handoff deep links retain entity identity', () => {
  for (const hash of [workPath, `#/work?workId=${encodeURIComponent(workId)}`, '#/issues?issueId=42']) {
    const route = appRouteFromHash(hash);
    assertPage(route, 'tasks');
    assert.equal(route.selectedWorkId, workId);
    assert.equal(appRouteFromHash(appHashForRoute(route)).selectedWorkId, workId);
  }
  for (const hash of ['#/command-center', '#/dashboard', '#/pi-inbox', '#/attention-inbox', '#/pi-approvals']) assertPage(appRouteFromHash(hash), 'inbox');
  for (const workBoardEnabled of [true, false]) {
    const route = appRouteFromHash(deliveryPath, { workBoardEnabled });
    assertPage(route, 'tasks'); // Existing delivery access intentionally bypasses the list feature flag.
    assert.equal(route.selectedWorkId, workId);
    assert.equal(route.selectedHandoffId, handoffId);
    assert.equal(appRouteFromHash(appHashForRoute(route)).selectedHandoffId, handoffId);
  }
  const standalone = appRouteFromHash(`#/handoffs/${encodeURIComponent(handoffId)}`);
  assertPage(standalone, 'handoffs');
  assert.equal(standalone.selectedHandoffId, handoffId);
  assert.equal(standalone.selectedWorkId, '');
});

test('D4 baseline 2: Run wins over session and unresolved or standalone executions retain their viewing route', () => {
  for (const id of [runId, 'external-run-without-work', 'missing-run', 'malformed:run']) {
    const route = appRouteFromHash(`#/runs?runId=${encodeURIComponent(id)}&sessionId=old-session`);
    assertPage(route, 'runs');
    assert.equal(route.selectedRunId, id);
    assert.equal(route.selectedSessionId, '');
    assert.deepEqual(appRouteFromHash(appHashForRoute(route)), route);
  }
  for (const page of ['runs', 'sessions']) {
    const route = appRouteFromHash(`#/${page}?sessionId=standalone-provider-session`);
    assertPage(route, 'runs');
    assert.equal(route.selectedSessionId, 'standalone-provider-session');
    assert.equal(route.selectedRunId, '');
  }
  const source = readFileSync(new URL('./pages/Runs.jsx', import.meta.url), 'utf8');
  const loading = source.slice(source.indexOf('runsApi.getRun('), source.indexOf('}, [activeRunId, detailReloadToken, surface]'));
  assert.match(loading, /catch\(detailError/);
  assert.doesNotMatch(loading, /navigateTo|location\s*=/);
  assert.match(source, /surface === 'compat-session'[\s\S]*autoSelectFirstSession=\{false\}[\s\S]*selectedSessionId=\{selectedSessionId\}/);
  assert.match(source, /runDetail \? \([\s\S]*<RunDetail[\s\S]*run-provider-empty/);
});

test('D4 baseline 3: conversation, project/source/scope and flag-off issue filters survive round trips', () => {
  const conversation = appRouteFromHash('#/pi-chat?conversationId=chat%2F42');
  assertPage(conversation, 'ask-xuanwu');
  assert.equal(conversation.selectedPiConversationId, 'chat/42');
  assert.deepEqual(appRouteFromHash(appHashForRoute(conversation)), conversation);
  for (const source of ['github', 'manual']) {
    const route = appRouteFromHash(`#/work?project=${encodeURIComponent('玄武 & one')}&source=${source}&scope=attention`);
    assertPage(route, 'tasks');
    assert.equal(route.filterProject, '玄武 & one');
    assert.equal(route.taskSource, source);
    assert.equal(route.taskScope, 'attention');
    assert.deepEqual(appRouteFromHash(appHashForRoute(route)), route);
  }
  for (const hash of ['#/issues?issueId=42&project=demo&focus=failed', `#/work?workId=${encodeURIComponent(workId)}&project=demo&focus=failed`]) {
    const route = appRouteFromHash(hash, { workBoardEnabled: false });
    assertPage(route, 'issues');
    assert.equal(route.selectedIssueId, 42);
    assert.equal(route.filterProject, 'demo');
    assert.equal(route.focusFilter, 'failed');
    assert.deepEqual(appRouteFromHash(appHashForRoute(route), { workBoardEnabled: false }), route);
  }
});

test('D4 baseline 4: bare and advanced settings links expand and scroll to the same section', () => {
  const source = readFileSync(new URL('./pages/AssistantSettingsSections.jsx', import.meta.url), 'utf8');
  // eslint-disable-next-line no-regex-spaces -- Match the frozen source indentation literally.
  const effect = source.match(/useEffect\(\(\) => \{\n    if \(!section\)([\s\S]*?)\n  \}, \[section\]\);/);
  assert.ok(effect, 'settings must keep its live deep-link expansion effect');
  for (const value of ['diagnostics', 'advanced:diagnostics']) {
    const route = appRouteFromHash(`#/settings?section=${encodeURIComponent(value)}`);
    assertPage(route, 'settings');
    assert.equal(route.settingsSection, value);
    const settings = resolveSettingsRoute(route.settingsSection);
    assert.deepEqual(settings, { tab: 'advanced', section: 'diagnostics' });
    let visited = new Set();
    let scrollBlock = '';
    const element = { open: false, scrollIntoView: options => { scrollBlock = options.block; } };
    runInNewContext(`(() => { if (!section)${effect[1]} })()`, {
      section: settings.section, sectionRefs: { current: { diagnostics: element } },
      setVisited: update => { visited = update(visited); },
    });
    assert.equal(element.open, true);
    assert.equal(visited.has('diagnostics'), true);
    assert.equal(scrollBlock, 'start');
    assert.deepEqual(appRouteFromHash(appHashForRoute(route)), route);
  }
});

test('D4 baseline 5: live browser callbacks preserve objects across back/forward, copy, refresh and writes', () => {
  const browser = browserHistory('#/command-center');
  const hash = `#/work?workId=${encodeURIComponent(workId)}&runId=${encodeURIComponent(runId)}&project=demo&source=github`;
  browser.visit(hash);
  assertPage(browser.state, 'tasks');
  assert.equal(browser.state.selectedWorkId, workId);
  assert.equal(browser.state.selectedRunId, runId);
  browser.visit('#/settings?section=advanced%3Adiagnostics');
  assertPage(browser.state, 'settings');
  browser.back();
  assertPage(browser.state, 'tasks');
  assert.equal(browser.state.selectedWorkId, workId);
  assert.equal(browser.state.selectedRunId, runId);
  assert.equal(browser.state.filterProject, 'demo');
  assert.equal(browser.state.taskSource, 'github');
  const copied = browserHistory(browser.hash());
  assert.deepEqual(copied.state, browser.state);
  assert.deepEqual(browserHistory(copied.hash()).state, copied.state);
  browser.forward();
  assertPage(browser.state, 'settings');
  assert.equal(browser.state.settingsSection, 'advanced:diagnostics');
  browser.back();
  browser.back();
  assertPage(browser.state, 'inbox');
  browser.write(appRouteFromHash(hash));
  assert.equal(appRouteFromHash(browser.hash()).selectedRunId, runId);
  browser.write(appRouteFromHash('#/ask-xuanwu?conversationId=chat-42'), { replace: true });
  assert.equal(appRouteFromHash(browser.hash()).selectedPiConversationId, 'chat-42');
  browser.back();
  assertPage(browser.state, 'inbox');
});
