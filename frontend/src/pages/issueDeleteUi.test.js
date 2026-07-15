import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workSource = readFileSync(new URL('../api/work.js', import.meta.url), 'utf8');
const cardSource = readFileSync(new URL('./IssueCard.jsx', import.meta.url), 'utf8');
const detailSource = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');
const detailActionsSource = readFileSync(new URL('./issue-detail/IssueDetailActions.jsx', import.meta.url), 'utf8');
const issuesSource = readFileSync(new URL('./Issues.jsx', import.meta.url), 'utf8');

test('issue delete UI uses DELETE API and protects in-progress issues', () => {
  assert.match(workSource, /deleteIssue:\s*\(id\)\s*=>\s*request\(`\/api\/issues\/\$\{id\}`,\s*\{[\s\S]*method:\s*'DELETE'/);
  assert.match(cardSource, /const canDelete = issue\.status !== 'in_progress'/);
  assert.match(detailActionsSource, /issue\.status !== 'in_progress'[\s\S]*<Trash2 size=\{14\} \/> 删除/);
  assert.match(issuesSource, /workApi\.deleteIssue\(issueToDelete\.id\)/);
  assert.doesNotMatch(`${detailSource}\n${detailActionsSource}`, /window\.confirm/);
  assert.doesNotMatch(issuesSource, /window\.confirm/);
});
