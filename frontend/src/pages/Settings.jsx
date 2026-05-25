import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, ServerCog } from 'lucide-react';
import CronTasksPanel from '../components/CronTasksPanel';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import IssueTemplatesPanel from './IssueTemplatesPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import ProviderAvailabilityPanel from './ProviderAvailabilityPanel';
import { APP_VERSION, buildVersionSummary } from '../version';

export default function Settings() {
  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%', minHeight: 0, flex: 1 }}>
      <div style={{ flexShrink: 0, padding: '24px 0 8px 0' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '6px' }}>系统设置</h1>
        <p style={{ color: 'var(--text-muted)' }}>管理全局执行配置与 Codex Issue Runner 行为。</p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '24px', paddingBottom: '24px' }}>
        <RuntimeStatusPanel />
        <ProviderAvailabilityPanel />
        <RestartPanel />
        <NotificationSettingsPanel />
        <CronTasksPanel />
        <IssueTemplatesPanel />
      </div>
    </div>
  );
}

function RuntimeStatusPanel() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { loadStatus(setStatus, setError, setLoading); }, []);

  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ServerCog size={18} color="var(--primary)" /> Runtime Status
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
            只读状态检查，不启动新的 Codex 深度探针。
          </p>
        </div>
        <button className="btn btn-secondary" onClick={() => loadStatus(setStatus, setError, setLoading)} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
          刷新
        </button>
      </div>
      {error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{error}</div>}
      {!error && <RuntimeStatusBody status={status} loading={loading} />}
    </section>
  );
}

function loadStatus(setStatus, setError, setLoading) {
  setLoading(true);
  api.getSystemStatus()
    .then(data => { setStatus(data); setError(''); })
    .catch(err => setError(err.message || '读取 runtime status 失败'))
    .finally(() => setLoading(false));
}

function RuntimeStatusBody({ status, loading }) {
  if (loading && !status) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>正在读取状态...</div>;
  }
  if (!status) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>暂无状态数据</div>;
  }
  const rows = [
    ['API', status.service?.alive ? 'alive' : 'down', status.service?.alive],
    ['DB', status.db?.ok ? 'ok' : status.db?.error || 'error', status.db?.ok],
    ['Codex command', status.codex?.command_ok ? status.config?.codex_cmd : status.codex?.command_error || 'missing', status.codex?.command_ok],
    ['Auth enabled', status.config?.auth_enabled ? 'enabled' : 'disabled', !status.config?.auth_enabled],
    ['Runner loops', `${status.runner?.running_loops || 0} running / ${status.runner?.in_progress_issues || 0} in progress`, true],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <VersionSummaryCard summary={buildVersionSummary(APP_VERSION, status)} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        {rows.map(([label, value, ok]) => (
          <div key={label} style={{ border: '1px solid var(--border-light)', borderRadius: '14px', padding: '12px', background: 'var(--bg-secondary)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '6px' }}>{label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, wordBreak: 'break-word' }}>
              <span className={`status-dot ${ok ? 'active' : 'idle'}`} style={{ width: '7px', height: '7px' }}></span>
              {value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VersionSummaryCard({ summary }) {
  const tone = summary.ok ? 'var(--success)' : 'var(--warning)';
  const background = summary.ok ? 'var(--success-glow)' : 'var(--warning-bg)';
  return (
    <div style={{ border: `1px solid ${tone}`, borderRadius: '14px', padding: '12px', background }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700 }}>
        {!summary.ok && <AlertTriangle size={16} color="var(--warning)" />}
        版本摘要
      </div>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '8px', fontSize: '0.86rem' }}>
        <span>Frontend: <strong>{summary.frontendVersion}</strong></span>
        <span>Backend: <strong>{summary.backendVersion}</strong></span>
        <span>Build stamp: <strong>{summary.distStampStatus}</strong></span>
      </div>
      {summary.buildStamp && (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '6px', wordBreak: 'break-all' }}>
          Runtime stamp: {summary.buildStamp}
        </div>
      )}
      <VersionWarnings warnings={summary.warnings} />
    </div>
  );
}

function VersionWarnings({ warnings }) {
  if (warnings.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '6px' }}>前后端版本与 build stamp 未发现明显 mismatch。</div>;
  }
  return (
    <ul style={{ margin: '8px 0 0 18px', color: 'var(--warning)', fontSize: '0.8rem' }}>
      {warnings.map(warning => <li key={warning}>{warning}</li>)}
    </ul>
  );
}

function RestartPanel() {
  const [restarting, setRestarting] = useState(false);

  const handleRestart = async () => {
    if (!window.confirm('确定重启 Codex Issue Runner？服务会短暂断开。')) return;
    setRestarting(true);
    try {
      await api.restartSystem();
      message.success('重启请求已发送，服务会短暂断开。');
    } catch (err) {
      setRestarting(false);
      message.error(err.message || '重启失败');
    }
  };

  return (
    <section className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RefreshCw size={18} color="var(--primary)" /> 服务重启
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          发送重启请求后，页面会短暂断开；由 launchd 等守护进程拉起新服务。
        </p>
      </div>
      <button className="btn btn-secondary" onClick={handleRestart} disabled={restarting}>
        <RefreshCw size={15} className={restarting ? 'spin-animation' : ''} />
        {restarting ? '重启中...' : '重启服务'}
      </button>
    </section>
  );
}
