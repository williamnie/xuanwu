import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = [
  readFileSync(new URL('../index.css', import.meta.url), 'utf8'),
  readFileSync(new URL('./IssueDetail.css', import.meta.url), 'utf8'),
].join('\n');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('issue detail error and terminal blocks constrain long unbroken text', () => {
  const gridRule = ruleFor('.issue-detail-overview-grid');
  assert.match(gridRule, /grid-template-columns:\s*minmax\(0,\s*1\.35fr\)\s+minmax\(340px,\s*0\.9fr\)/);

  for (const selector of ['.issue-detail-page,\n.issue-detail-grid,\n.issue-detail-main,\n.issue-detail-side', '.issue-error-card', '.terminal-view']) {
    assert.match(ruleFor(selector), /min-width:\s*0/);
  }

  assert.match(ruleFor('.issue-error-text'), /overflow-wrap:\s*anywhere/);
  assert.match(ruleFor('.issue-error-text'), /white-space:\s*pre-wrap/);
  assert.match(ruleFor('.terminal-line'), /overflow-wrap:\s*anywhere/);
  assert.match(ruleFor('.terminal-line'), /white-space:\s*pre-wrap/);
  assert.match(ruleFor('.diff-line'), /overflow-wrap:\s*anywhere/);
});

test('issue detail workspace keeps activity, notes, and advanced data in bounded responsive grids', () => {
  assert.match(ruleFor('.issue-activity-grid'), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(280px,\s*340px\)/);
  assert.match(ruleFor('.issue-advanced-grid'), /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(ruleFor('.issue-description-content'), /max-height:\s*240px/);
  assert.match(ruleFor('.issue-detail-terminal'), /max-height:\s*620px/);
});

test('issue workflow evidence panel keeps compact long evidence inside sidebar', () => {
  for (const selector of ['.issue-workflow-panel', '.issue-workflow-steps', '.issue-workflow-step', '.issue-workflow-evidence-summary', '.issue-workflow-latest-run']) {
    assert.match(ruleFor(selector), /min-width:\s*0/);
  }

  assert.match(ruleFor('.issue-workflow-step-evidence'), /overflow-wrap:\s*anywhere/);
  assert.match(ruleFor('.issue-workflow-summary-field strong,\n.issue-workflow-latest-run strong,\n.issue-workflow-latest-run code,\n.issue-workflow-latest-run p'), /overflow-wrap:\s*anywhere/);
});

test('issue detail exposes PI supervisor panel without native browser dialogs', () => {
  const source = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');
  const panelSource = readFileSync(new URL('./IssueSupervisorPanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /api\.getIssueSupervisor\(issueId\)/);
  assert.match(source, /import IssueSupervisorPanel from '\.\/IssueSupervisorPanel'/);
  assert.match(source, /<IssueSupervisorPanel supervisor=\{supervisor\} \/>/);
  assert.match(panelSource, /PI Supervisor/);
  assert.match(panelSource, /retry-after wait/);
  assert.match(panelSource, /Recovery history/);
  assert.doesNotMatch(`${source}\n${panelSource}`, /window\.alert|window\.confirm|window\.prompt/);

  for (const selector of ['.issue-supervisor-panel', '.issue-supervisor-history']) {
    assert.match(ruleFor(selector), /min-width:\s*0/);
  }
  assert.match(ruleFor('.issue-supervisor-header p,\n.issue-supervisor-empty,\n.issue-supervisor-field p,\n.issue-supervisor-retry p,\n.issue-supervisor-history p'), /overflow-wrap:\s*anywhere/);
});
