import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const referencesCss = readFileSync(new URL('./PromptEditorReferences.css', import.meta.url), 'utf8');
const promptEditorJsx = readFileSync(new URL('./PromptEditor.jsx', import.meta.url), 'utf8');

function ruleFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('composer reference chips render above the editor without a context inspector strip', () => {
  const stackRule = ruleFor(referencesCss, '.prompt-editor-composer-stack');
  const areaRule = ruleFor(referencesCss, '.prompt-reference-area');
  const chipRule = ruleFor(referencesCss, '.prompt-reference-chip');
  const labelRule = ruleFor(referencesCss, '.prompt-reference-label');

  assert.match(promptEditorJsx, /<div className="prompt-editor-composer-stack">[\s\S]*<PromptEditorReferences[\s\S]*\{editorShell\}/);
  assert.match(stackRule, /display:\s*grid/);
  assert.match(areaRule, /display:\s*flex/);
  assert.match(chipRule, /border-radius:\s*var\(--radius-xs\)/);
  assert.match(labelRule, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(referencesCss, /prompt-context-inspector/);
  assert.doesNotMatch(promptEditorJsx, /prompt-context-inspector/);
  assert.doesNotMatch(promptEditorJsx, /prompt-context-inspector-head/);
});
