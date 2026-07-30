import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollBottomDistance,
  isNearScrollBottom,
} from './smartAutoScroll.js';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./smartAutoScroll.js', import.meta.url), 'utf8');

test('treats tiny bottom offsets as near bottom', () => {
  const element = { scrollHeight: 1000, scrollTop: 399, clientHeight: 600 };

  assert.equal(getScrollBottomDistance(element), 1);
  assert.equal(isNearScrollBottom(element), true);
});

test('pauses auto scroll when user is farther than threshold from bottom', () => {
  const element = {
    scrollHeight: 2000,
    scrollTop: 2000 - 600 - AUTO_SCROLL_BOTTOM_THRESHOLD_PX - 1,
    clientHeight: 600,
  };

  assert.equal(isNearScrollBottom(element), false);
});

test('clamps overscroll distance to zero', () => {
  const element = { scrollHeight: 500, scrollTop: 20, clientHeight: 600 };

  assert.equal(getScrollBottomDistance(element), 0);
  assert.equal(isNearScrollBottom(element), true);
});

test('force scroll key resumes following after an explicit user action', () => {
  assert.match(source, /if \(!forceScrollKey\) return;/);
  assert.match(source, /shouldFollowRef\.current = true;\s*scheduleScrollToBottom\('auto'\);/);
});
