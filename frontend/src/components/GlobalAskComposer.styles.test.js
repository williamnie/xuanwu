import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./GlobalAskComposer.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./GlobalAskComposer.jsx', import.meta.url), 'utf8');

test('global composer uses the verified editor keyboard and upload surface', () => {
  assert.match(source, /<SessionComposer/);
  assert.match(source, /onSubmit=\{handleSubmit\}/);
  assert.match(source, /suggestions=\{suggestions\}/);
  assert.match(source, /referenceDetails=\{referenceDetails\}/);
  assert.match(source, /requirePrompt/);
  assert.doesNotMatch(source, /window\.alert|window\.confirm/);
});

test('global Work suggestions use one bounded page instead of a full ledger fan-out', () => {
  assert.match(source, /workApi\.getWorks\(\)/);
  assert.doesNotMatch(source, /workApi\.getAllWorks\(\)/);
});

test('global composer remains reachable on mobile and respects safe areas', () => {
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /bottom:\s*max\(8px, env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?left:\s*12px;[\s\S]*?right:\s*12px;/);
  assert.match(css, /\.sidebar-collapsed \.global-ask-composer-shell/);
  assert.match(css, /\.global-ask-composer-launcher/);
});

test('global composer starts as a compact launcher and expands as an overlay without reserving page height', () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(source, /className="global-ask-composer-launcher"/);
  assert.match(source, /onClick=\{\(\) => setExpanded\(true\)\}/);
  assert.doesNotMatch(css, /\.main-content\.has-global-ask-composer\s*\{/);
  assert.doesNotMatch(css, /padding-bottom:\s*(?:190|176|88|72)px/);
});

test('page and portal dialog composers hide the global overlay without matching its own editor', () => {
  assert.match(css, /\.main-content:has\(\.prompt-editor-shell\.composer\) ~ \.global-ask-composer-shell,\s*body:has\(> \.modal-overlay \.prompt-editor-shell\.composer\) \.global-ask-composer-shell\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /(?:body|\.app-container):has\(\.prompt-editor-shell\.composer\)/);
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<main className="main-content"[\s\S]*?<\/main>[\s\S]*?<GlobalAskComposer/);
  const editor = readFileSync(new URL('./editor/PromptEditor.jsx', import.meta.url), 'utf8');
  assert.match(editor, /prompt-editor-shell \$\{isComposer \? 'composer' : ''\}/);
});
