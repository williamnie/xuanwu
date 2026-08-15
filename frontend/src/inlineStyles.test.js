import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import test from 'node:test';

const SRC_ROOT = new URL('.', import.meta.url).pathname;
const ALLOWED_RUNTIME_INLINE_STYLES = {
  'components/AppSidebar.jsx': 1,
  'components/CodexUsageBreakdown.jsx': 1,
  'components/CodexUsagePanel.jsx': 1,
  'components/editor/PromptEditor.jsx': 2,
  'pages/IssueCardMoreActions.jsx': 1,
  'pages/WorkBoard.jsx': 1,
};

test('JSX files do not accumulate inline styles', () => {
  const inlineStyleCounts = jsxFiles(SRC_ROOT)
    .map((file) => ({
      file: relative(SRC_ROOT, file),
      count: (readFileSync(file, 'utf8').match(/\bstyle\s*=\s*\{/g) || []).length,
    }))
    .filter(({ count }) => count > 0)
    .sort((left, right) => left.file.localeCompare(right.file));

  const expected = Object.entries(ALLOWED_RUNTIME_INLINE_STYLES)
    .map(([file, count]) => ({ file, count }))
    .sort((left, right) => left.file.localeCompare(right.file));

  assert.deepEqual(
    inlineStyleCounts,
    expected,
    'Extract static styles into the owning component CSS module; only reviewed runtime-calculated styles may remain.',
  );
});

function jsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return jsxFiles(path);
    return extname(entry.name) === '.jsx' ? [path] : [];
  });
}
