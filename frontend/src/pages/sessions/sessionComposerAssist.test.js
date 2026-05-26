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
