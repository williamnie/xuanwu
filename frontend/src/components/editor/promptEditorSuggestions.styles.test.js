import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const suggestionsCss = readFileSync(new URL('./PromptEditorSuggestions.css', import.meta.url), 'utf8');
const editorCss = readFileSync(new URL('./PromptEditor.css', import.meta.url), 'utf8');

function ruleFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('composer suggestions pop above the editor instead of inside it', () => {
  const composerRule = ruleFor(suggestionsCss, '.prompt-editor-shell.composer');
  const menuRule = ruleFor(suggestionsCss, '.prompt-suggestion-menu');
  const baseEditorRule = ruleFor(editorCss, '.prompt-editor-shell');

  assert.match(baseEditorRule, /overflow:\s*hidden/);
  assert.match(composerRule, /overflow:\s*visible/);
  assert.match(menuRule, /bottom:\s*calc\(100%\s*\+\s*8px\)/);
  assert.doesNotMatch(menuRule, /bottom:\s*46px/);
});
