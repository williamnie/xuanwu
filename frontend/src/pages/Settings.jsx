import { useEffect, useState } from 'react';
import { AlertTriangle, Copy, Download, RefreshCw, ServerCog } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import IssueTemplatesPanel from './IssueTemplatesPanel';
import FeishuSettingsPanel from './FeishuSettingsPanel';
import PiAgentSettingsPanel from './PiAgentSettingsPanel';
import PiMemoryPanel from './PiMemoryPanel';
import ProviderAvailabilityPanel from './ProviderAvailabilityPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import RuntimeLogsPanel from '../components/RuntimeLogsPanel';
import { formatRuntimeLogsSummary } from '../utils/runtimeLogs';
import { APP_VERSION, buildVersionSummary } from '../version';
import { SettingsHeader } from './SettingsChrome';
import './Settings.css';

export default function Settings() {
  const [activeTab, setActiveTab] = useState('runtime');
  return (
    <div className="settings-page animate-fade-in">
      <SettingsHeader activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="settings-tab-content" role="tabpanel">
        {activeTab === 'runtime' && <RuntimeSettingsTab />}
        {activeTab === 'agent' && <AgentSettingsTab />}
        {activeTab === 'integrations' && <IntegrationsSettingsTab />}
        {activeTab === 'templates' && <TemplatesSettingsTab />}
      </div>
    </div>
  );
}

function RuntimeSettingsTab() {
  return (
    <>
      <RuntimeStatusPanel />
      <RunnerSettingsPanel />
      <ProviderAvailabilityPanel />
    </>
  );
}

function AgentSettingsTab() {
  return (
    <>
      <PiAgentSettingsPanel />
      <PiMemoryPanel />
    </>
  );
}

function IntegrationsSettingsTab() {
  return <FeishuSettingsPanel />;
}

function TemplatesSettingsTab() {
  return <IssueTemplatesPanel />;
}

function RuntimeStatusPanel() {
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(true);
  const [error, setError] = useState('');
  const [logsError, setLogsError] = useState('');
  const [doctorLoading, setDoctorLoading] = useState(false);

  useEffect(() => {
    loadStatus(setStatus, setError, setLoading);
    loadLogs(setLogs, setLogsError, setLogsLoading);
  }, []);

  const handleCopyDoctor = () => copyDoctor(setDoctorLoading);
  const handleDownloadDoctor = () => downloadDoctor(setDoctorLoading);
  const handleCopyLogs = () => copyLogs(logs);
  const handleRefresh = () => {
    loadStatus(setStatus, setError, setLoading);
    loadLogs(setLogs, setLogsError, setLogsLoading);
  };

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
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={handleCopyDoctor} disabled={doctorLoading}>
            <Copy size={15} />
            复制诊断摘要
          </button>
          <button className="btn btn-secondary" onClick={handleDownloadDoctor} disabled={doctorLoading}>
            <Download size={15} />
            下载 JSON
          </button>
          <button className="btn btn-secondary" onClick={handleRefresh} disabled={loading || logsLoading}>
            <RefreshCw size={15} className={(loading || logsLoading) ? 'spin-animation' : ''} />
            刷新
          </button>
        </div>
      </div>
      {error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{error}</div>}
      {!error && <RuntimeStatusBody status={status} loading={loading} />}
      <RuntimeLogsPanel logs={logs} loading={logsLoading} error={logsError} onCopy={handleCopyLogs} />
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

function loadLogs(setLogs, setError, setLoading) {
  setLoading(true);
  api.getRuntimeLogs(120)
    .then(data => { setLogs(data); setError(''); })
    .catch(err => setError(err.message || '读取 runtime logs 失败'))
    .finally(() => setLoading(false));
}

async function copyDoctor(setDoctorLoading) {
  await withDoctor(setDoctorLoading, async (summary) => {
    await copyText(formatDoctor(summary));
    message.success('诊断摘要已复制');
  });
}

async function downloadDoctor(setDoctorLoading) {
  await withDoctor(setDoctorLoading, async (summary) => {
    downloadText(`codex-runtime-doctor-${safeTimestamp(summary.generated_at)}.json`, formatDoctor(summary));
    message.success('诊断 JSON 已下载');
  });
}

async function copyLogs(logs) {
  if (!logs) {
    message.error('暂无日志摘要可复制');
    return;
  }
  try {
    await copyText(formatRuntimeLogsSummary(logs));
    message.success('Runtime 日志摘要已复制');
  } catch (err) {
    message.error(err.message || '复制日志摘要失败');
  }
}

async function withDoctor(setDoctorLoading, action) {
  setDoctorLoading(true);
  try {
    await action(await api.getRuntimeDoctor());
  } catch (err) {
    message.error(err.message || '生成诊断摘要失败');
  } finally {
    setDoctorLoading(false);
  }
}

function formatDoctor(summary) {
  return JSON.stringify(summary, null, 2);
}

function safeTimestamp(value) {
  return (value || new Date().toISOString()).replace(/[:.]/g, '-');
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
  return Promise.resolve();
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
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
    ['Runner loops', `${status.runner?.running_loops || 0} running / ${status.runner?.in_progress_issues || 0} in progress / max ${status.runner?.max_parallel_projects || 1}`, true],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <VersionSummaryCard summary={buildVersionSummary(APP_VERSION, status)} />
      <SecurityWarnings warnings={status.security?.warnings || []} />
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

function SecurityWarnings({ warnings }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div style={{ border: '1px solid var(--warning)', borderRadius: '14px', padding: '12px', background: 'var(--warning-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700 }}>
        <AlertTriangle size={16} color="var(--warning)" />
        安全诊断告警
      </div>
      <ul style={{ margin: '8px 0 0 18px', color: 'var(--warning)', fontSize: '0.82rem' }}>
        {warnings.map(warning => (
          <li key={warning.code}>{warning.message || warning.code}</li>
        ))}
      </ul>
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
