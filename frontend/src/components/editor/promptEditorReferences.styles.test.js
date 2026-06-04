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

test('composer reference context renders above the editor as a compact strip', () => {
  const stackRule = ruleFor(referencesCss, '.prompt-editor-composer-stack');
  const areaRule = ruleFor(referencesCss, '.prompt-reference-area');
  const inspectorRule = ruleFor(referencesCss, '.prompt-context-inspector');
  const summaryRule = ruleFor(referencesCss, '.prompt-context-inspector-summary');

  assert.match(promptEditorJsx, /<div className="prompt-editor-composer-stack">[\s\S]*<PromptEditorReferences[\s\S]*\{editorShell\}/);
  assert.match(stackRule, /display:\s*grid/);
  assert.match(areaRule, /display:\s*flex/);
  assert.match(inspectorRule, /border-radius:\s*999px/);
  assert.match(inspectorRule, /min-height:\s*30px/);
  assert.match(inspectorRule, /overflow:\s*hidden/);
  assert.match(summaryRule, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(promptEditorJsx, /prompt-context-inspector-head/);
});
