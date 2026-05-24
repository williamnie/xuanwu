import { Check, Clock, ShieldAlert, X } from 'lucide-react';
import './ApprovalDialog.css';

export default function ApprovalDialog({ request, submitting, onResolve }) {
  if (!request) return null;
  const title = approvalTitle(request.method);
  const detail = approvalDetail(request);
  return (
    <div className="approval-overlay">
      <section className="approval-card" role="dialog" aria-modal="true" aria-label={title}>
        <header className="approval-header">
          <div className="approval-mark"><ShieldAlert size={19} /></div>
          <div>
            <h3>{title}</h3>
            <p>{detail.subtitle}</p>
          </div>
        </header>
        <ApprovalBody detail={detail} />
        <div className="approval-actions">
          <button type="button" className="approval-btn ghost" disabled={submitting} onClick={() => onResolve('deny')}>
            <X size={15} /> 拒绝
          </button>
          <button type="button" className="approval-btn secondary" disabled={submitting} onClick={() => onResolve('approve_session', 'session')}>
            <Clock size={15} /> 本会话允许
          </button>
          <button type="button" className="approval-btn primary" disabled={submitting} onClick={() => onResolve('approve', 'turn')}>
            <Check size={15} /> 允许
          </button>
        </div>
      </section>
    </div>
  );
}

function ApprovalBody({ detail }) {
  return (
    <div className="approval-body">
      {detail.reason && <div className="approval-reason">{detail.reason}</div>}
      {detail.command && (
        <div className="approval-command">
          <span>Command</span>
          <pre>{detail.command}</pre>
        </div>
      )}
      {detail.paths.length > 0 && (
        <div className="approval-paths">
          <span>Files</span>
          {detail.paths.map((path) => <code key={path}>{path}</code>)}
        </div>
      )}
      {detail.cwd && <div className="approval-meta"><span>cwd</span><code>{detail.cwd}</code></div>}
    </div>
  );
}

function approvalTitle(method) {
  if (method?.includes('fileChange') || method === 'applyPatchApproval') return 'Allow Codex to edit files?';
  if (method?.includes('permissions')) return 'Allow requested permissions?';
  return 'Allow Codex to run this command?';
}

function approvalDetail(request) {
  const params = request.params || {};
  return {
    subtitle: subtitleForMethod(request.method),
    reason: params.reason || '',
    command: commandFromLegacy(params),
    cwd: params.cwd || '',
    paths: pathsFromParams(params),
  };
}

function subtitleForMethod(method) {
  if (method?.includes('permissions')) return 'Codex is requesting extra access for this turn.';
  if (method?.includes('fileChange') || method === 'applyPatchApproval') return 'Review the requested file change before continuing.';
  return 'Codex needs your approval before executing outside the current policy.';
}

function commandFromLegacy(params) {
  if (typeof params.command === 'string') return params.command;
  if (Array.isArray(params.command)) return params.command.join(' ');
  return '';
}

function pathsFromParams(params) {
  if (Array.isArray(params.changes)) return params.changes.map((item) => item.path).filter(Boolean);
  const entries = params.permissions?.fileSystem?.entries || [];
  return entries.map((entry) => entry?.path?.path || entry?.path?.pattern || entry?.path?.value?.kind).filter(Boolean);
}
