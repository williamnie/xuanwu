import assert from 'node:assert/strict';
import test from 'node:test';

import { Editor } from '@tiptap/core';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';

import { getPromptEditorExtensions } from './promptEditorCore.js';
import { remarkPlainLocalDocSelfLinks } from './localDocLinks.js';

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };
const LOCAL_DOC_PATH_EXAMPLE = 'docs/integrations/[home-v2-frontend-diff.md](http://home-v2-frontend-diff.md)';

function createEditor(markdown = '') {
  const editor = new Editor({
    element: null,
    extensions: getPromptEditorExtensions(),
    content: EMPTY_DOC,
    immediatelyRender: false,
  });
  if (markdown) editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
  return editor;
}

function hasLinkMark(node) {
  if (!node) return false;
  if ((node.marks || []).some(mark => mark.type === 'link')) return true;
  return (node.content || []).some(child => hasLinkMark(child));
}

test('pasted local document path markdown is serialized as plain text', () => {
  const editor = createEditor();
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));

  const paragraph = editor.schema.nodes.paragraph.create(null, editor.schema.text(LOCAL_DOC_PATH_EXAMPLE));
  editor.view.dispatch(editor.state.tr.replaceSelection(paragraph.slice(0)).setMeta('uiEvent', 'paste'));

  assert.equal(editor.getMarkdown(), LOCAL_DOC_PATH_EXAMPLE);
  assert.equal(hasLinkMark(editor.getJSON()), false);

  editor.destroy();
});

test('local document path markdown parses back as plain editor text', () => {
  const editor = createEditor(LOCAL_DOC_PATH_EXAMPLE);

  assert.equal(editor.getMarkdown(), LOCAL_DOC_PATH_EXAMPLE);
  assert.equal(hasLinkMark(editor.getJSON()), false);

  editor.destroy();
});

test('manual links remain available through link command', () => {
  const editor = createEditor('Open docs');
  editor.commands.setTextSelection({ from: 1, to: 5 });
  editor.commands.setLink({ href: 'https://example.com/docs' });

  assert.equal(editor.getMarkdown(), '[Open](https://example.com/docs) docs');
  assert.equal(hasLinkMark(editor.getJSON()), true);

  editor.destroy();
});

test('stored markdown links still parse and serialize as links', () => {
  const editor = createEditor('[guide](https://example.com/guide)');

  assert.equal(editor.getMarkdown(), '[guide](https://example.com/guide)');
  assert.equal(hasLinkMark(editor.getJSON()), true);

  editor.destroy();
});

test('markdown preview plugin keeps local document self-link as plain text', () => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkPlainLocalDocSelfLinks);
  const tree = processor.runSync(processor.parse(LOCAL_DOC_PATH_EXAMPLE));
  const links = [];
  visit(tree, 'link', node => links.push(node.url));

  assert.deepEqual(links, []);
});

test('attachment image markdown still serializes with attachment protocol', () => {
  const editor = createEditor('![uploaded image](attachment://upload_test)');

  assert.equal(editor.getMarkdown(), '![uploaded image](attachment://upload_test)');
  assert.equal(editor.getJSON().content?.[0]?.attrs?.src, 'attachment://upload_test');

  editor.destroy();
});

test('prompt editor link extension does not install automatic link plugins', () => {
  const editor = createEditor();
  const pluginKeys = editor.extensionManager.plugins.map(plugin => plugin.key || '');

  assert.equal(pluginKeys.some(key => key.startsWith('autolink$')), false);
  assert.equal(pluginKeys.some(key => key.startsWith('handlePasteLink$')), false);

  editor.destroy();
});
