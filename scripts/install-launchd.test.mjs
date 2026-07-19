import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./install-launchd.sh', import.meta.url), 'utf8');

test('launchd deployment atomically replaces the running Mach-O inode', () => {
  assert.match(source, /stage_file_atomically\(\)/);
  assert.match(source, /mktemp "\$target_dir\/\.codex-runner-stage\.XXXXXX"/);
  assert.match(source, /mv -f "\$staged" "\$target"/);
  assert.match(source, /stage_file_atomically "\$BINARY_PATH" "\$LAUNCHD_BINARY_PATH" 0755/);
  assert.doesNotMatch(source, /cp "\$BINARY_PATH" "\$LAUNCHD_BINARY_PATH"/);
});

test('launchd deployment stages controlled PI runtime resources with package assets', () => {
  assert.match(source, /RUNNER_SKILLS_SOURCE=.*\$ROOT_DIR\/skills/);
  assert.match(source, /copy_if_exists "\$RUNNER_SKILLS_SOURCE" "\$PI_PACKAGE_ASSET_DIR\/skills"/);
  assert.match(source, /copy_if_exists "\$RUNNER_PLUGINS_SOURCE" "\$PI_PACKAGE_ASSET_DIR\/plugins"/);
  assert.match(source, /<key>PI_PACKAGE_DIR<\/key>/);
});

test('launchd deployment persists the explicit W1 automation shadow selector', () => {
  assert.match(source, /AUTOMATION_SHADOW_W1="\$\{CODEX_RUNNER_AUTOMATION_SHADOW_W1:-0\}"/);
  assert.match(source, /CODEX_RUNNER_AUTOMATION_SHADOW_W1 must be 0 or 1/);
  assert.match(source, /<key>CODEX_RUNNER_AUTOMATION_SHADOW_W1<\/key>/);
  assert.match(source, /<string>\$\(xml_escape "\$AUTOMATION_SHADOW_W1"\)<\/string>/);
});
