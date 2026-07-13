import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./Projects.css', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('project config modal is viewport bounded and scrollable', () => {
  assert.match(source, /className="glass-card modal-content project-config-modal"/);

  const rule = ruleFor('.project-config-modal');
  assert.match(rule, /max-height:\s*calc\(100vh - 48px\)/);
  assert.match(rule, /overflow-y:\s*auto/);
  assert.match(rule, /overscroll-behavior:\s*contain/);
});

test('project cards keep low-frequency metadata behind compact details', () => {
  assert.match(source, /className="glass-card project-card"/);
  assert.match(source, /<details className="project-card-details">/);
  assert.match(source, /<ProjectMetaRow label="Provider"/);
  assert.match(source, /<ProjectMetaRow label="Capabilities"/);
  assert.match(source, /<ProjectMetaRow label="Agent Profile"/);
  assert.match(source, /<ProjectMetaRow label="默认速度"/);

  const cardRule = ruleFor('.project-card');
  assert.match(cardRule, /gap:\s*10px/);
  assert.match(cardRule, /padding:\s*12px/);

  const footerRule = ruleFor('.project-card-footer');
  assert.match(footerRule, /grid-template-columns:\s*auto minmax\(0, 1fr\)/);
});

test('project config modal reads Codex model options from provider API', () => {
  assert.match(source, /api\.getCodexModels\(\)/);
  assert.match(source, /buildCodexModelOptions\(codexModels, formModel, profileForm\.model\)/);
  assert.match(source, /codexModelOptions\.map\(option =>/);
  assert.doesNotMatch(source, /CODEX_MODEL_OPTIONS\.some\(option => option\.value === model\)/);
});
