import assert from 'node:assert/strict';
import test from 'node:test';

import { placeFloatingMenu } from './floatingMenu.js';

const menuRect = { width: 132, height: 72 };
const viewport = { width: 320, height: 240 };

test('floating menu flips to start alignment near the left viewport edge', () => {
  const result = placeFloatingMenu({
    anchorRect: { left: 4, right: 32, top: 80, bottom: 104, width: 28, height: 24 },
    menuRect,
    viewport,
  });

  assert.equal(result.placement, 'bottom-start');
  assert.equal(result.left, 8);
});

test('floating menu keeps end alignment near the right viewport edge', () => {
  const result = placeFloatingMenu({
    anchorRect: { left: 292, right: 320, top: 80, bottom: 104, width: 28, height: 24 },
    menuRect,
    viewport,
  });

  assert.equal(result.placement, 'bottom-end');
  assert.equal(result.left, 180);
});

test('floating menu opens upward when there is not enough room below', () => {
  const result = placeFloatingMenu({
    anchorRect: { left: 120, right: 148, top: 214, bottom: 238, width: 28, height: 24 },
    menuRect,
    viewport,
  });

  assert.match(result.placement, /^top-/);
  assert.ok(result.top < 214);
});
