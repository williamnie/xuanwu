import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const sources = Object.fromEntries(readdirSync(root, { recursive: true })
  .filter(path => path.endsWith('.jsx') && !path.includes('.test.'))
  .map(path => [path, readFileSync(new URL(path, root), 'utf8')]));

function iconTags(source) {
  const names = ['Icon']; // Local aliases select an existing lucide component.
  for (const [, imports] of source.matchAll(/import\s*\{([^}]+)\}\s*from ['"]lucide-react/g)) {
    names.push(...imports.split(',').map(name => name.trim().split(' as ').at(-1)).filter(Boolean));
  }
  return [...source.matchAll(new RegExp(`<(${names.join('|')})\\b([^<>]*?)/>`, 'gs'))];
}

test('lucide icon props and CSS use the spec 7 size tiers and stroke 2', () => {
  const foundation = readFileSync(new URL('./GeekWorkbench.css', root), 'utf8');
  assert.match(foundation, /button \.lucide, \.btn \.lucide \{ height: 14px; width: 14px; \}/);
  for (const [file, source] of Object.entries(sources)) {
    for (const [, icon, props] of iconTags(source)) {
      const size = props.match(/\bsize=\{([^}]+)\}/)?.[1];
      assert.ok(['13', '14', '15', '16', '34'].includes(size), `${file}: ${icon} size ${size}`);
    }
    for (const [, width] of source.matchAll(/strokeWidth=\{([^}]+)\}/g)) assert.equal(width, '2', file);
    assert.doesNotMatch(source, /from ['"](?:react-icons|@fortawesome)/, file);
  }
  for (const file of readdirSync(root, { recursive: true }).filter(file => file.endsWith('.css'))) {
    const css = readFileSync(new URL(file, root), 'utf8');
    for (const [, width] of css.matchAll(/stroke-width:\s*([^;]+);/g)) assert.equal(width, '2', file);
  }
});
