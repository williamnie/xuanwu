import assert from 'node:assert/strict';
import test from 'node:test';

import { enqueueLocalPromptValue, reconcilePromptEditorValue } from './promptEditorValueSync.js';

test('does not reapply locally emitted values when parent renders lag behind rapid IME updates', () => {
  const pasted = 'Goal Contract\nRunner outcome: needs_user | <reason>. ';
  let pending = [];
  pending = enqueueLocalPromptValue(pending, `${pasted}z`);
  pending = enqueueLocalPromptValue(pending, `${pasted}zh`);
  pending = enqueueLocalPromptValue(pending, `${pasted}zha`);

  const staleEcho = reconcilePromptEditorValue(`${pasted}zha`, `${pasted}z`, pending);
  assert.equal(staleEcho.apply, false);
  assert.deepEqual(staleEcho.pendingValues, [`${pasted}zh`, `${pasted}zha`]);

  const nextEcho = reconcilePromptEditorValue(`${pasted}zha`, `${pasted}zh`, staleEcho.pendingValues);
  assert.equal(nextEcho.apply, false);
  assert.deepEqual(nextEcho.pendingValues, [`${pasted}zha`]);
});

test('applies an actual external value change', () => {
  assert.deepEqual(
    reconcilePromptEditorValue('draft', 'replacement', ['draft']),
    { apply: true, pendingValues: [] },
  );
});

test('does not rewrite the editor when it already matches the external value', () => {
  assert.deepEqual(
    reconcilePromptEditorValue('draft', 'draft', []),
    { apply: false, pendingValues: [] },
  );
});
