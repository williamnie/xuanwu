import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollBottomDistance,
  isNearScrollBottom,
} from './smartAutoScroll.js';

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
