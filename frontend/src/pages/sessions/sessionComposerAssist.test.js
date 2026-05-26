import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionComposerSuggestions,
  issueCommandPrompt,
  issueReferenceText,
  projectReferenceText,
  statusCommandPrompt,
} from './sessionComposerAssist.js';

test('builds slash commands and readable project/issue references', () => {
  const suggestions = buildSessionComposerSuggestions({
    currentProject: { id: 'runner', name: 'Codex Runner' },
    projects: [{ id: 'runner', name: 'Codex Runner', cwd: '/repo' }],
    issues: [{ id: 69, title: '增强 Session 输入', status: 'todo', project_id: 'runner' }],
  });

  assert.deepEqual(suggestions.filter((item) => item.trigger === '/').map((item) => item.label), ['/issue', '/status']);
  assert.ok(suggestions.some((item) => item.insertText === '@project:runner Codex Runner'));
  const issueSuggestion = suggestions.find((item) => item.insertText === '#69 增强 Session 输入');
  assert.ok(issueSuggestion);
  assert.match(issueSuggestion.searchText, /issue 69 #69/);
});

test('command prompts stay on the existing plain prompt channel', () => {
  assert.match(issueCommandPrompt({ id: 'runner', name: 'Codex Runner' }), /项目：@project:runner Codex Runner/);
  assert.match(issueCommandPrompt(), /## 验收/);
  assert.match(statusCommandPrompt([{ id: 69, title: '增强 Session 输入' }]), /关联 issue：#69 增强 Session 输入/);
});

test('reference text normalizes whitespace', () => {
  assert.equal(projectReferenceText({ id: 'demo', name: 'Demo\nProject' }), '@project:demo Demo Project');
  assert.equal(issueReferenceText({ id: 7, title: 'Fix\tbug' }), '#7 Fix bug');
});
