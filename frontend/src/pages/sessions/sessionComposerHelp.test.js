import assert from 'node:assert/strict';
import test from 'node:test';

import { COMPOSER_HELP_ITEMS } from './sessionComposerHelp.js';

test('composer help explains structured references and workflow commands', () => {
  const text = COMPOSER_HELP_ITEMS.join('\n');

  assert.match(text, /@/);
  assert.match(text, /attach context|附加上下文/);
  assert.match(text, /\//);
  assert.match(text, /workflow|工作流/);
  assert.doesNotMatch(text, /@project/);
  assert.match(text, /project 由页面项目选择器决定/);
});
