import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFrontend = createRequire(resolve(root, 'frontend/package.json'));

test('Markdown attribute parsing preserves quoted values after the security update', () => {
  const { createAtomBlockMarkdownSpec, createInlineMarkdownSpec } = requireFrontend('@tiptap/core');
  const block = createAtomBlockMarkdownSpec({ nodeName: 'probe' }).markdownTokenizer;
  const inline = createInlineMarkdownSpec({ nodeName: 'probe', selfClosing: true }).markdownTokenizer;
  assert.deepEqual(block.tokenize(':::probe {label="hello world"} :::\n', [], {}).attributes, { label: 'hello world' });
  assert.deepEqual(inline.tokenize('[probe label="hello world"]', [], {}).attributes, { label: 'hello world' });
});

test('Malformed Markdown attributes do not stall the parser', { timeout: 10_000 }, () => {
  // 放到独立进程，旧版的二次复杂度回归不会卡住整个测试进程。
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const requireFrontend = createRequire(new URL('./frontend/package.json', import.meta.url));
    const { createAtomBlockMarkdownSpec, createInlineMarkdownSpec } = requireFrontend('@tiptap/core');
    const block = createAtomBlockMarkdownSpec({ nodeName: 'probe' }).markdownTokenizer;
    const inline = createInlineMarkdownSpec({ nodeName: 'probe', selfClosing: true }).markdownTokenizer;
    block.tokenize(':::probe {' + '__QUOTED_0'.repeat(12000) + '__} :::\\n', [], {});
    inline.tokenize('[probe ' + '0'.repeat(100000) + ']', [], {});
    process.stdout.write('bounded');
  `], { cwd: root, encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'bounded');
});
