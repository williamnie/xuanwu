import { Loader2, TerminalSquare, X } from 'lucide-react';
import {
  commandDefinition,
  commandRequiresConfirmation,
  commandTargetSummary,
  validateSessionCommand,
} from './sessionCommands';
import './SessionCommandPanel.css';

export default function SessionCommandPanel({
  commandState,
  context,
  executing,
  result,
  error,
  onExecute,
  onCancel,
}) {
  const definition = commandDefinition(commandState);
  if (!definition) return null;
  const validation = validateSessionCommand(commandState, context);
  const needsConfirm = commandRequiresConfirmation(commandState);
  const target = commandTargetSummary(commandState, context);
  return (
    <div className={`session-command-panel ${needsConfirm ? 'danger' : ''}`} data-command={definition.name}>
      <div className="session-command-main">
        <div className="session-command-title-row">
          <span className="session-command-icon"><TerminalSquare size={14} /></span>
          <div>
            <strong>{definition.label} · {definition.title}</strong>
            <p>{definition.description}</p>
          </div>
        </div>
        <div className="session-command-chips" aria-label="Command parameters">
          <span className="session-command-chip">command.name={definition.name}</span>
          {definition.name !== 'issue' && <span className="session-command-chip">target={target}</span>}
          {needsConfirm && <span className="session-command-chip warning">需要二次确认</span>}
        </div>
        {validation && !result && <div className="session-command-error">{validation}</div>}
        {error && <div className="session-command-error">{error}</div>}
        {result && <CommandResult result={result} />}
      </div>
      <div className="session-command-actions">
        <button type="button" className="session-command-cancel" onClick={onCancel} disabled={executing}>
          <X size={13} /> 取消
        </button>
        <button type="button" className="session-command-execute" onClick={onExecute} disabled={executing || Boolean(validation)}>
          {executing ? <Loader2 className="animate-spin" size={13} /> : null}
          {definition.actionLabel}
        </button>
      </div>
    </div>
  );
}

function CommandResult({ result }) {
  const issue = result.issue;
  const project = result.project;
  return (
    <div className="session-command-result" role="status">
      <strong>{result.summary || 'Command completed'}</strong>
      {issue && <span>Issue #{issue.id} · {issue.status} · {issue.title}</span>}
      {project && <span>Project {project.id} · loop {project.loop_status || 'unknown'}</span>}
      {result.system?.runner && <span>Runner loops {result.system.runner.running_loops} · in progress {result.system.runner.in_progress_issues}</span>}
    </div>
  );
}
