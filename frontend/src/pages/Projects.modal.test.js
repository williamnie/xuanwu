import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('./ProjectSettingsEditor.jsx', import.meta.url), 'utf8');
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
  assert.match(editorSource, /'project-config-modal-form'/);
  assert.match(editorSource, /'project-config-modal-body'/);
  assert.match(editorSource, /'project-config-modal-footer'/);

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

test('project cards keep only operational information and move configuration behind settings', () => {
  assert.match(source, /className="glass-card project-card"/);
  assert.match(source, /className="project-status-pill"/);
  assert.match(source, /className="project-card-stats"/);
  assert.match(source, /aria-label={`编辑 \${proj\.name} 配置`}/);
  assert.match(source, /onManageProject\?\.\(proj\.id\)/);
  assert.doesNotMatch(source, /handleOpenEditModal/);
  assert.doesNotMatch(source, /<details className="project-card-details">/);
  assert.doesNotMatch(source, /ProjectMetaRow/);
  assert.doesNotMatch(source, />Capabilities</);
  assert.doesNotMatch(source, />运行模式</);
  assert.doesNotMatch(css, /\.project-card-details/);
  assert.doesNotMatch(css, /\.project-card-meta/);

  const cardRule = ruleFor('.project-card');
  assert.match(cardRule, /gap:\s*10px/);
  assert.match(cardRule, /padding:\s*12px/);

  const footerRule = ruleFor('.project-card-footer');
  assert.match(footerRule, /display:\s*flex/);
  assert.match(footerRule, /justify-content:\s*flex-end/);
});

test('project card actions share one compact control height', () => {
  const actionsRule = ruleFor('.project-card-actions');
  assert.match(actionsRule, /--project-card-control-height:\s*32px/);
  assert.match(actionsRule, /align-items:\s*center/);

  const buttonRule = ruleFor('.project-card-actions .btn');
  assert.match(buttonRule, /height:\s*var\(--project-card-control-height\)/);
  assert.match(buttonRule, /min-height:\s*var\(--project-card-control-height\)/);

  const iconButtonRule = ruleFor('.project-card-actions .project-card-icon-btn');
  assert.match(iconButtonRule, /min-width:\s*var\(--project-card-control-height\)/);
  assert.match(css, /\.project-card-delete-btn:hover:not\(:disabled\)\s*\{/);
});

test('project config modal reads Codex model options from provider API', () => {
  assert.match(editorSource, /systemApi\.getCodexModels\(\)/);
  assert.match(editorSource, /buildCodexModelOptions\(ui\.codexModels, ui\.formModel, ui\.profileForm\.model\)/);
  assert.match(editorSource, /modelOptions\.map\(option =>/);
  assert.match(editorSource, /远端 model API 读取失败，已启用手填/);
  assert.match(editorSource, /模型 API 失败，请手动填写 model ID/);
  assert.doesNotMatch(editorSource, /FALLBACK_CODEX_MODEL_OPTIONS/);
  assert.doesNotMatch(editorSource, /CODEX_MODEL_OPTIONS\.some\(option => option\.value === model\)/);
});
