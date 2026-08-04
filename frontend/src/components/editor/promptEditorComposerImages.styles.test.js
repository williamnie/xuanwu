import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const imageCss = readFileSync(new URL('./PromptEditorComposerImages.css', import.meta.url), 'utf8');
const promptEditorJsx = readFileSync(new URL('./PromptEditor.jsx', import.meta.url), 'utf8');

function ruleFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('composer image attachments render inside the editable input shell', () => {
  const areaRule = ruleFor(imageCss, '.prompt-image-attachment-area');
  const cardRule = ruleFor(imageCss, '.prompt-image-attachment-card');

  assert.match(promptEditorJsx, /const editorShell = \([\s\S]*<PromptEditorComposerImages[\s\S]*<EditorContent/);
  assert.match(areaRule, /display:\s*flex/);
  assert.match(areaRule, /padding:\s*12px\s+14px\s+0/);
  assert.match(cardRule, /width:\s*92px/);
  assert.match(cardRule, /height:\s*76px/);
});
