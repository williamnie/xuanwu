import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPromptSuggestionContext,
  filterPromptSuggestionItems,
  nextPromptSuggestionIndex,
  promptSuggestionKeyAction,
  samePromptSuggestionContext,
} from './promptEditorSuggestions.js';

test('filters suggestions by trigger and search query', () => {
  const items = [
    { trigger: '/', label: '/issue', searchText: 'create issue' },
    { trigger: '@', label: '@project runner', searchText: 'project runner' },
    { trigger: '@', label: '#69 Session composer', searchText: 'issue session composer' },
  ];

  const matches = filterPromptSuggestionItems(items, { trigger: '@', query: 'issue' });

  assert.deepEqual(matches.map((item) => item.label), ['#69 Session composer']);
});

test('cycles active suggestion index within menu bounds', () => {
  assert.equal(nextPromptSuggestionIndex(0, 1, 3), 1);
  assert.equal(nextPromptSuggestionIndex(2, 1, 3), 0);
  assert.equal(nextPromptSuggestionIndex(0, -1, 3), 2);
  assert.equal(nextPromptSuggestionIndex(4, 1, 0), 0);
});

test('maps menu keyboard actions for selection and cancel', () => {
  assert.equal(promptSuggestionKeyAction({ key: 'ArrowDown' }), 'next');
  assert.equal(promptSuggestionKeyAction({ key: 'ArrowUp' }), 'previous');
  assert.equal(promptSuggestionKeyAction({ key: 'Escape' }), 'close');
  assert.equal(promptSuggestionKeyAction({ key: 'Enter' }), 'pick');
  assert.equal(promptSuggestionKeyAction({ key: 'Enter', shiftKey: true }), '');
});

test('compares active prompt suggestion context exactly', () => {
  const context = { trigger: '/', query: 'issue', from: 3, to: 9 };

  assert.equal(samePromptSuggestionContext(context, { ...context }), true);
  assert.equal(samePromptSuggestionContext(context, { ...context, query: 'status' }), false);
});


test('detects @project alias and replaces only the search tail', () => {
  const editor = fakeEditor('@project run');
  const context = detectPromptSuggestionContext(editor);

  assert.deepEqual(context, { trigger: '@', query: 'project run', from: 0, to: 12 });
});

test('detects skill and plugin aliases for context and request hints', () => {
  assert.deepEqual(detectPromptSuggestionContext(fakeEditor('@skill brow')), {
    trigger: '@', query: 'skill brow', from: 0, to: 11,
  });
  assert.deepEqual(detectPromptSuggestionContext(fakeEditor('/plugin git')), {
    trigger: '/', query: 'plugin git', from: 0, to: 11,
  });
});

function fakeEditor(text) {
  return {
    state: {
      selection: { empty: true, from: text.length },
      doc: { textBetween: (start, end) => text.slice(start, end) },
    },
  };
}
