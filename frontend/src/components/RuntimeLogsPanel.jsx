import { Copy, FileText } from 'lucide-react';
import { runtimeLogStats } from '../utils/runtimeLogs';
import './RuntimeLogsPanel.css';

export default function RuntimeLogsPanel({ logs, loading, error, onCopy }) {
  const stats = runtimeLogStats(logs);
  return (
    <div className="runtime-logs-panel">
      <div className="runtime-logs-panel__header">
        <div>
          <div className="runtime-logs-panel__title">
            <FileText size={16} color="var(--primary)" />
            Runtime Logs
          </div>
          <div className="runtime-logs-panel__summary">
            最近 {logs?.line_limit || 120} 行摘要 · errors {stats.errors} · warnings {stats.warnings} · missing {stats.missing}
          </div>
        </div>
        <button className="btn btn-secondary" onClick={onCopy} disabled={!logs || loading}>
          <Copy size={15} />
          复制日志摘要
        </button>
      </div>
      {loading && !logs && <div className="runtime-logs-panel__empty">正在读取 runtime logs...</div>}
      {error && <div className="runtime-logs-panel__error">{error}</div>}
      {!error && logs && <RuntimeLogsBody logs={logs} />}
    </div>
  );
}

function RuntimeLogsBody({ logs }) {
  return (
    <div className="runtime-logs-panel__body">
      <ImportantLogLines title="最近错误" lines={logs.recent_errors || []} empty="最近日志中未发现 error/panic/failed。" tone="error" />
      <ImportantLogLines title="最近 warning" lines={logs.recent_warnings || []} empty="最近日志中未发现 warning。" tone="warning" />
      <LogPathList logs={logs.logs || []} />
    </div>
  );
}

function ImportantLogLines({ title, lines, empty, tone }) {
  return (
    <div>
      <div className="runtime-logs-panel__section-title">{title}</div>
      {lines.length === 0 ? (
        <div className="runtime-logs-panel__section-empty">{empty}</div>
      ) : (
        <div className="runtime-logs-panel__lines">
          {lines.slice(0, 5).map((line, index) => <LogLine key={`${line.source}-${line.time}-${index}`} line={line} tone={tone} />)}
        </div>
      )}
    </div>
  );
}

function LogLine({ line, tone }) {
  return (
    <div className={`runtime-logs-panel__line is-${tone}`}>
      <div className="runtime-logs-panel__line-meta">
        {line.source || 'runtime'} · {line.time || 'time unknown'} · {line.level || 'info'}
      </div>
      <code className="runtime-logs-panel__line-text">
        {line.text}
      </code>
    </div>
  );
}

function LogPathList({ logs }) {
  if (logs.length === 0) {
    return <div className="runtime-logs-panel__section-empty">未配置 runtime 日志路径。</div>;
  }
  return (
    <div>
      <div className="runtime-logs-panel__section-title">日志路径</div>
      <div className="runtime-logs-panel__lines">
        {logs.map(log => (
          <div className={`runtime-logs-panel__path${log.available ? '' : ' is-unavailable'}`} key={`${log.source}-${log.path}`}>
            <span className={`status-dot runtime-logs-panel__path-dot ${log.available ? 'active' : 'idle'}`}></span>
            <span className="runtime-logs-panel__path-copy">
              <strong>{log.source || 'runtime'}:</strong> {log.path || 'unknown'}
              {!log.available && <span> · {log.error || '不可用'}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
