import React from 'react';
import { Clipboard, ExternalLink, GitBranch } from 'lucide-react';

export default function IssueWorkflowEvidencePanel({ workflow, navigateTo, onCopy }) {
  if (!workflow) return null;
  const latestRun = workflow.latestRun;
  return React.createElement('section', { className: 'glass-card issue-workflow-panel' },
    React.createElement('div', { className: 'issue-workflow-header' },
      React.createElement('div', null,
        React.createElement('h3', null, React.createElement(GitBranch, { size: 18 }), ' Workflow / Evidence'),
        React.createElement('p', null, workflow.nextAction),
      ),
      React.createElement('button', {
        type: 'button', className: 'kanban-card-action-btn', onClick: () => onCopy?.(workflowCopyText(workflow)),
      }, React.createElement(Clipboard, { size: 12 }), ' 复制 Evidence'),
    ),
    React.createElement('div', { className: 'issue-workflow-steps' },
      workflow.steps.map(step => React.createElement(WorkflowStepRow, { key: step.id, step })),
    ),
    React.createElement('div', { className: 'issue-workflow-evidence-summary' },
      React.createElement(SummaryField, { label: 'Explicit final status', value: workflow.explicitFinalStatus || '未回写' }),
      React.createElement(SummaryField, { label: 'Verification evidence', value: workflow.verificationEvidence.summary }),
    ),
    latestRun ? React.createElement(LatestRunEvidence, { run: latestRun, navigateTo, onCopy }) :
      React.createElement('p', { className: 'issue-workflow-empty' }, '暂无 latest run evidence。'),
  );
}

export function workflowCopyText(workflow) {
  const lines = ['Workflow / Evidence'];
  for (const step of workflow.steps || []) {
    lines.push(`- ${step.label}: ${step.state} — ${step.evidence || ''}`);
  }
  lines.push(`Final status: ${workflow.explicitFinalStatus || 'none'}`);
  lines.push(`Verification: ${workflow.verificationEvidence?.summary || '未找到 verification evidence'}`);
  if (workflow.latestRun) {
    lines.push(`Latest run: attempt #${workflow.latestRun.attempt || '?'} ${workflow.latestRun.status || ''}`.trim());
    lines.push(`Session: ${workflow.latestRun.sessionRef || workflow.latestRun.sessionId || 'none'}`);
    lines.push(`Turn: ${workflow.latestRun.turnId || 'none'}`);
  }
  lines.push(`Next: ${workflow.nextAction || ''}`);
  return lines.join('\n');
}

function WorkflowStepRow({ step }) {
  return React.createElement('article', { className: `issue-workflow-step ${step.state}` },
    React.createElement('div', { className: 'issue-workflow-step-top' },
      React.createElement('strong', null, step.label),
      React.createElement('span', { className: `issue-workflow-state ${step.state}` }, stateLabel(step.state)),
    ),
    React.createElement('p', { className: 'issue-workflow-step-evidence' }, step.evidence),
  );
}

function SummaryField({ label, value }) {
  return React.createElement('div', { className: 'issue-workflow-summary-field' },
    React.createElement('span', null, label),
    React.createElement('strong', null, value),
  );
}

function LatestRunEvidence({ run, navigateTo, onCopy }) {
  const canOpenSession = Boolean(run.sessionRef && navigateTo);
  return React.createElement('div', { className: 'issue-workflow-latest-run' },
    React.createElement('div', null,
      React.createElement('span', null, 'Latest run'),
      React.createElement('strong', null, `Attempt #${run.attempt || '?'} · ${run.status || 'unknown'}`),
      React.createElement('code', null, run.sessionRef || run.sessionId || 'no-session'),
      React.createElement('code', null, run.turnId ? `Turn ${run.turnId}` : 'no-turn'),
      run.exitText ? React.createElement('p', null, run.exitText) : null,
    ),
    React.createElement('div', { className: 'issue-workflow-run-actions' },
      canOpenSession ? React.createElement('button', {
        type: 'button', className: 'kanban-card-action-btn', onClick: () => navigateTo('sessions', null, run.sessionRef),
      }, React.createElement(ExternalLink, { size: 12 }), ' 打开 Session') : null,
      React.createElement('button', {
        type: 'button', className: 'kanban-card-action-btn', onClick: () => onCopy?.(latestRunCopyText(run)),
      }, React.createElement(Clipboard, { size: 12 }), ' 复制 Run'),
    ),
  );
}

function latestRunCopyText(run) {
  return [
    `Attempt: ${run.attempt || '?'}`,
    `Status: ${run.status || 'unknown'}`,
    `Provider: ${run.providerLabel || run.provider || 'unknown'}`,
    `Session: ${run.sessionRef || run.sessionId || 'none'}`,
    `Turn: ${run.turnId || 'none'}`,
    `Exit: ${run.exitText || run.exit_reason || 'none'}`,
  ].join('\n');
}

function stateLabel(state) {
  switch (state) {
    case 'done': return 'done';
    case 'active': return 'active';
    case 'blocked': return 'blocked';
    case 'warning': return 'needs evidence';
    case 'missing': return 'missing';
    default: return 'pending';
  }
}
