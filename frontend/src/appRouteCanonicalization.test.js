import { readAppSource } from '../test-support/readAppSource.js';
import assert from 'node:assert/strict';

import test from 'node:test';
import { canonicalAppHash, watchCanonicalAppHash } from './appRouteCanonicalization.js';
import { appHashForRoute, appRouteFromHash } from './appRouteModel.js';

test('legacy normalization preserves every query byte and delivery path segment', () => {
  const suffixes = [
    '', '?', '?project=a%20b&project=a+b&opaque=%2f%2F&empty=&flag',
    '?q=one?two&source=github&scope=attention&unknown=%E7%8E%84%E6%AD%A6',
    '/xw%3awork%3Aissues%3a42/delivery/xw%3ahandoff%3Aderived%3a42?project=a%2fb',
    '?workId=xw%3awork%3Aissues%3a42&runId=run-42',
  ];
  for (const [legacy, canonical] of [['work', 'tasks'], ['command-center', 'inbox']]) {
    for (const suffix of suffixes) assert.equal(canonicalAppHash(`#/${legacy}${suffix}`), `#/${canonical}${suffix}`);
  }
  assert.equal(canonicalAppHash('#/%77ork?x=%2f'), '#/tasks?x=%2f');
  for (const hash of ['#/tasks?x=%2f', '#/inbox', '#/runs?runId=one', '#/settings?section=diagnostics', '#/issues?issueId=42', '#/%?x=1', '#/toString', '#/workshop', '']) {
    assert.equal(canonicalAppHash(hash), hash);
  }
});

test('normalization replaces the current history entry on load, back/forward and pasted hashes', () => {
  const entries = ['#/work?unknown=a%20b', '#/command-center?opaque=%2f'];
  let index = 1;
  const calls = [];
  const listeners = new Map();
  const browser = {
    location: { pathname: '/web/', search: '?host=a%20b', hash: entries[index] },
    history: {
      state: { scroll: 42 },
      replaceState(state, title, href) {
        calls.push({ state, title, href });
        entries[index] = href.slice(href.indexOf('#'));
        browser.location.hash = entries[index];
      },
    },
    addEventListener: (event, listener) => listeners.set(event, listener),
    removeEventListener: (event, listener) => { assert.equal(listeners.get(event), listener); listeners.delete(event); },
  };
  const stop = watchCanonicalAppHash(browser);
  assert.equal(browser.location.hash, '#/inbox?opaque=%2f');
  assert.deepEqual(calls[0], { state: browser.history.state, title: '', href: '/web/?host=a%20b#/inbox?opaque=%2f' });
  index = 0;
  browser.location.hash = entries[index];
  listeners.get('popstate')();
  assert.equal(browser.location.hash, '#/tasks?unknown=a%20b');
  index = 1;
  browser.location.hash = entries[index];
  listeners.get('popstate')();
  assert.equal(calls.length, 2);
  assert.equal(entries.length, 2);
  browser.location.hash = '#/work?source=manual';
  listeners.get('hashchange')();
  assert.equal(browser.location.hash, '#/tasks?source=manual');
  stop();
  assert.equal(listeners.size, 0);
  const app = readAppSource();
  assert.match(app, /useLayoutEffect\(\(\) => watchCanonicalAppHash\(\), \[\]\)/);
});

test('active page navigation serializes only relevant state instead of copying an old raw query', () => {
  const oldRoute = appRouteFromHash('#/work?project=one&source=github&scope=done&unknown=a%20b');
  assert.equal(appHashForRoute({ ...oldRoute, currentPage: 'settings', settingsSection: 'diagnostics' }), '#/settings?section=diagnostics');
  assert.equal(appHashForRoute({ ...oldRoute, currentPage: 'inbox' }), '#/inbox');
  assert.equal(appHashForRoute(oldRoute), '#/tasks?scope=done&source=github&project=one');
});
