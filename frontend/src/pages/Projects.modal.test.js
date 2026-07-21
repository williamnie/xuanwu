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

test('project config modal keeps its header and footer fixed while its body scrolls', () => {
  assert.match(source, /className="glass-card modal-content project-config-modal"/);
  assert.match(source, /className="project-config-modal-header"/);
  assert.match(source, /className="project-config-modal-form"/);
  assert.match(source, /className="project-config-modal-body"/);
  assert.match(source, /className="project-config-modal-footer"/);

  const modalRule = ruleFor('.project-config-modal');
  assert.match(modalRule, /max-height:\s*calc\(100vh - 48px\)/);
  assert.match(modalRule, /overflow:\s*hidden/);

  const formRule = ruleFor('.project-config-modal-form');
  assert.match(formRule, /flex:\s*1 1 auto/);
  assert.match(formRule, /min-height:\s*0/);

  const bodyRule = ruleFor('.project-config-modal-body');
  assert.match(bodyRule, /flex:\s*1 1 auto/);
  assert.match(bodyRule, /overflow-y:\s*auto/);
  assert.match(bodyRule, /overscroll-behavior:\s*contain/);

  const footerRule = ruleFor('.project-config-modal-footer');
  assert.match(footerRule, /flex:\s*0 0 auto/);
  assert.match(footerRule, /justify-content:\s*flex-end/);
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
  assert.match(source, /systemApi\.getCodexModels\(\)/);
  assert.match(source, /buildCodexModelOptions\(codexModels, formModel, profileForm\.model\)/);
  assert.match(source, /codexModelOptions\.map\(option =>/);
  assert.match(source, /远端 model API 读取失败，已启用手填/);
  assert.match(source, /模型 API 失败，请手动填写 model ID/);
  assert.doesNotMatch(source, /FALLBACK_CODEX_MODEL_OPTIONS/);
  assert.doesNotMatch(source, /CODEX_MODEL_OPTIONS\.some\(option => option\.value === model\)/);
});
