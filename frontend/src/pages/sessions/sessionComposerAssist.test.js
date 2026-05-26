import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionComposerSuggestions,
  issueReferenceText,
  projectReferenceText,
} from './sessionComposerAssist.js';

test('builds slash commands and readable project/issue references', () => {
  const suggestions = buildSessionComposerSuggestions({
    currentProject: { id: 'runner', name: 'Codex Runner' },
    projects: [{ id: 'runner', name: 'Codex Runner', cwd: '/repo' }],
    issues: [{ id: 69, title: '增强 Session 输入', status: 'todo', project_id: 'runner' }],
  });

  assert.deepEqual(suggestions.filter((item) => item.trigger === '/').map((item) => item.label), ['/status', '/issue', '/run']);
  assert.ok(suggestions.some((item) => item.insertText === '@project:runner Codex Runner'));
  const issueSuggestion = suggestions.find((item) => item.insertText === '#69 增强 Session 输入');
  assert.ok(issueSuggestion);
  assert.match(issueSuggestion.searchText, /issue 69 #69/);
});

test('prioritizes issues before projects for empty @ suggestions', () => {
  const projects = Array.from({ length: 9 }, (_, index) => ({
    id: `project-${index + 1}`,
    name: `Project ${index + 1}`,
    cwd: `/repo/${index + 1}`,
  }));
  const suggestions = buildSessionComposerSuggestions({
    projects,
    issues: [{ id: 92, title: '真实上下文引用', status: 'triage', project_id: 'runner' }],
  });

  const mentionLabels = suggestions.filter((item) => item.trigger === '@').map((item) => item.label);

  assert.equal(mentionLabels[0], '#92 真实上下文引用');
  assert.match(mentionLabels[1], /@project Project 1/);
});

test('builds skill and plugin context references and request hints', () => {
  const suggestions = buildSessionComposerSuggestions({
    capabilities: {
      skills: [{ name: 'browser', summary: 'Browser automation' }],
      plugins: [{ name: 'github', summary: 'GitHub connector' }],
    },
  });

  const skillReference = suggestions.find((item) => item.label === '@skill browser');
  const pluginReference = suggestions.find((item) => item.label === '@plugin github');
  const skillHint = suggestions.find((item) => item.label === '/skill browser');
  const pluginHint = suggestions.find((item) => item.label === '/plugin github');

  assert.deepEqual(skillReference.reference, {
    type: 'skill',
    name: 'browser',
    label: 'browser',
    metadata: { summary: 'Browser automation', intent: 'context' },
  });
  assert.deepEqual(pluginReference.reference.type, 'plugin');
  assert.deepEqual(skillHint.reference.metadata.intent, 'request');
  assert.match(skillHint.description, /请求使用/);
  assert.deepEqual(pluginHint.reference.metadata.intent, 'request');
});

test('builds file and folder context reference suggestions', () => {
  const suggestions = buildSessionComposerSuggestions({
    pathReferences: {
      files: [{ path: 'frontend/src/pages/Sessions.jsx', size_bytes: 1024 }],
      folders: [{ path: 'frontend/src/pages', file_count: 3 }],
    },
  });

  const file = suggestions.find((item) => item.label === '@file frontend/src/pages/Sessions.jsx');
  const folder = suggestions.find((item) => item.label === '@folder frontend/src/pages');

  assert.deepEqual(file.reference, {
    type: 'file',
    path: 'frontend/src/pages/Sessions.jsx',
    label: 'frontend/src/pages/Sessions.jsx',
    metadata: { size_bytes: 1024 },
  });
  assert.deepEqual(folder.reference.type, 'folder');
  assert.equal(folder.reference.metadata.file_count, 3);
});

test('slash suggestions expose structured command payloads', () => {
  const suggestions = buildSessionComposerSuggestions({
    currentProject: { id: 'runner', name: 'Codex Runner' },
    linkedIssues: [{ id: 69, title: '增强 Session 输入' }],
  });
  const status = suggestions.find((item) => item.id === 'command-status');
  const issue = suggestions.find((item) => item.id === 'command-issue');
  const run = suggestions.find((item) => item.id === 'command-run');

  assert.deepEqual(status.command, { name: 'status', args: { issue_id: 69 } });
  assert.equal(status.insertText, '');
  assert.deepEqual(issue.command, { name: 'issue', args: { project_id: 'runner' } });
  assert.deepEqual(run.command, { name: 'run', args: { issue_id: 69 }, requires_confirmation: true });
});

test('reference text normalizes whitespace', () => {
  assert.equal(projectReferenceText({ id: 'demo', name: 'Demo\nProject' }), '@project:demo Demo Project');
  assert.equal(issueReferenceText({ id: 7, title: 'Fix\tbug' }), '#7 Fix bug');
});
