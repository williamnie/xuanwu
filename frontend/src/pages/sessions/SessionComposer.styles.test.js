import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./SessionComposer.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./SessionComposer.jsx', import.meta.url), 'utf8');
const sessionsSource = readFileSync(new URL('../Sessions.jsx', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('queued messages stay compact directly above composer input', () => {
  const panelRule = ruleFor('.session-message-queue-panel');
  const itemRule = ruleFor('.session-message-queue-item');
  const textRule = ruleFor('.session-message-queue-text');

  assert.match(panelRule, /margin-bottom:\s*6px/);
  assert.match(itemRule, /border-radius:\s*12px/);
  assert.match(itemRule, /padding:\s*7px\s+9px/);
  assert.match(textRule, /text-overflow:\s*ellipsis/);
  assert.match(textRule, /white-space:\s*nowrap/);
});

test('running composer defaults to guidance without top queue hint', () => {
  assert.match(source, /running && onFollowModeChange/);
  assert.match(source, /<ComposerModeSwitch value=\{followMode\}/);
  assert.match(source, /followMode = true/);
  assert.match(sessionsSource, /\[followRunningTurn,\s*setFollowRunningTurn\]\s*=\s*useState\(true\)/);
  assert.doesNotMatch(css, /session-message-queue-hint/);
  assert.doesNotMatch(source, /className="session-message-queue-hint" role="status"/);
  assert.doesNotMatch(source, /发送会排队为下一条/);
});

test('running stop action is visibly distinct from disabled sending spinner', () => {
  const stopRule = ruleFor('.session-composer-circle.stop');
  assert.match(source, /className="session-composer-circle stop"/);
  assert.match(stopRule, /animation:\s*composer-stop-pulse/);
  assert.match(stopRule, /background:\s*#ef4444/);
  assert.match(css, /@keyframes composer-stop-pulse/);
});


test('session composer exposes a speed control backed by service tier', () => {
  assert.match(source, /SERVICE_TIER_STANDARD/);
  assert.match(source, /className="speed"/);
  assert.match(source, /onSettingChange\('serviceTier', value\)/);
  assert.match(source, /serviceTierOptions\(effectiveModel, settings\.serviceTier\)/);
});

test('session model remains a selector when the model API is unavailable', () => {
  assert.doesNotMatch(source, /aria-label="手动填写模型 ID"/);
  assert.match(source, /title=\{modelHint\(modelsLoading, modelsError\)\}/);
  assert.match(source, /models\.map\(\(model\) => <option/);
  assert.doesNotMatch(css, /\.session-composer-model-manual input/);
});
