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
