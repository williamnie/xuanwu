import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractIssueTemplateVariables,
  renderIssuePromptTemplate,
} from './issuePromptTemplate.js';

test('renders issue and project variables for create preview', () => {
  const rendered = renderIssuePromptTemplate(
    'cwd={{project.cwd}}\ntitle={{issue.title}}\ndesc={{issue.description}}\ncontent={{issue.content}}\npriority={{issue.priority}}',
    {
      project: { id: 'demo', name: 'Demo', cwd: '/repo/demo' },
      issue: { title: '修复预览', description: '补模板预览', priority: 2 },
    },
  );

  assert.equal(rendered, 'cwd=/repo/demo\ntitle=修复预览\ndesc=补模板预览\ncontent=补模板预览\npriority=2');
});

test('extracts unknown template variables without blocking render', () => {
  const template = '已知={{issue.title}}\n未知={{issue.missing}}\n重复={{issue.missing}}';

  const variables = extractIssueTemplateVariables(template);
  const rendered = renderIssuePromptTemplate(template, {
    issue: { title: '标题', description: '', priority: 0 },
  });

  assert.deepEqual(variables.unknown, ['issue.missing']);
  assert.equal(rendered, '已知=标题\n未知={{issue.missing}}\n重复={{issue.missing}}');
});
