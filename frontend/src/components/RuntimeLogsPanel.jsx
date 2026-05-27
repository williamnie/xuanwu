import { Copy, FileText } from 'lucide-react';
import { runtimeLogStats } from '../utils/runtimeLogs';

export default function RuntimeLogsPanel({ logs, loading, error, onCopy }) {
  const stats = runtimeLogStats(logs);
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700 }}>
            <FileText size={16} color="var(--primary)" />
            Runtime Logs
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '4px' }}>
            最近 {logs?.line_limit || 120} 行摘要 · errors {stats.errors} · warnings {stats.warnings} · missing {stats.missing}
          </div>
        </div>
        <button className="btn btn-secondary" onClick={onCopy} disabled={!logs || loading}>
          <Copy size={15} />
          复制日志摘要
        </button>
      </div>
      {loading && !logs && <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>正在读取 runtime logs...</div>}
      {error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{error}</div>}
      {!error && logs && <RuntimeLogsBody logs={logs} />}
    </div>
  );
}

function RuntimeLogsBody({ logs }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <ImportantLogLines title="最近错误" lines={logs.recent_errors || []} empty="最近日志中未发现 error/panic/failed。" tone="var(--error)" />
      <ImportantLogLines title="最近 warning" lines={logs.recent_warnings || []} empty="最近日志中未发现 warning。" tone="var(--warning)" />
      <LogPathList logs={logs.logs || []} />
    </div>
  );
}

function ImportantLogLines({ title, lines, empty, tone }) {
  return (
    <div>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '6px' }}>{title}</div>
      {lines.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>{empty}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {lines.slice(0, 5).map((line, index) => <LogLine key={`${line.source}-${line.time}-${index}`} line={line} tone={tone} />)}
        </div>
      )}
    </div>
  );
}

function LogLine({ line, tone }) {
  return (
    <div style={{ borderLeft: `3px solid ${tone}`, padding: '8px 10px', background: 'var(--bg-card)', borderRadius: '10px' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: '4px' }}>
        {line.source || 'runtime'} · {line.time || 'time unknown'} · {line.level || 'info'}
      </div>
      <code style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.78rem', color: 'var(--text-primary)' }}>
        {line.text}
      </code>
    </div>
  );
}

function LogPathList({ logs }) {
  if (logs.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>未配置 runtime 日志路径。</div>;
  }
  return (
    <div>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '6px' }}>日志路径</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {logs.map(log => (
          <div key={`${log.source}-${log.path}`} style={logPathStyle(log.available)}>
            <span className={`status-dot ${log.available ? 'active' : 'idle'}`} style={{ width: '7px', height: '7px', marginTop: '5px', flex: '0 0 auto' }}></span>
            <span style={{ overflowWrap: 'anywhere' }}>
              <strong>{log.source || 'runtime'}:</strong> {log.path || 'unknown'}
              {!log.available && <span> · {log.error || '不可用'}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const panelStyle = {
  border: '1px solid var(--border-light)',
  borderRadius: '14px',
  padding: '12px',
  background: 'var(--bg-secondary)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

function logPathStyle(available) {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    fontSize: '0.8rem',
    color: available ? 'var(--text-secondary)' : 'var(--warning)',
  };
}
