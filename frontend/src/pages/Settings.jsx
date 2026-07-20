import { systemApi } from '../api/system.js';
import { connectorsApi } from '../api/connectors.js';
import { useEffect, useState } from 'react';
import { AlertTriangle, Copy, Download, RefreshCw, ServerCog } from 'lucide-react';
import { message } from '../store/toastStore';
import RuntimeLogsPanel from '../components/RuntimeLogsPanel';
import { PanelLoader } from '../components/TurtleLoader';
import { formatRuntimeLogsSummary } from '../utils/runtimeLogs';
import { buildRuntimeDiagnosticsBundle, formatRuntimeDiagnosticsBundle } from '../utils/runtimeDiagnostics';
import { APP_VERSION, buildVersionSummary } from '../version';
import SettingsTabContent from './AssistantSettingsSections';
import { SettingsHeader } from './SettingsChrome';
import { resolveSettingsRoute } from './settingsNavigation';
import './Settings.css';

export default function Settings({ initialTab = 'general', navigateTo, pageTitle }) {
  const [route, setRoute] = useState(() => resolveSettingsRoute(initialTab));

  useEffect(() => {
    setRoute(resolveSettingsRoute(initialTab));
  }, [initialTab]);

  return (
    <div className="settings-page animate-fade-in">
      <SettingsHeader onRouteChange={setRoute} route={route} title={pageTitle} />
      <div className="settings-tab-content" role="tabpanel">
        <SettingsTabContent activeTab={route.tab} tier={route.tier} RuntimeStatusPanel={RuntimeStatusPanel} navigateTo={navigateTo} />
      </div>
    </div>
  );
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
  const handleDownloadDiagnostics = () => downloadDiagnostics(setDoctorLoading);
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
          <button className="btn btn-secondary" onClick={handleDownloadDiagnostics} disabled={doctorLoading}>
            <Download size={15} />
            下载诊断包
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
  systemApi.getSystemStatus()
    .then(data => { setStatus(data); setError(''); })
    .catch(err => setError(err.message || '读取 runtime status 失败'))
    .finally(() => setLoading(false));
}

function loadLogs(setLogs, setError, setLoading) {
  setLoading(true);
  systemApi.getRuntimeLogs(120)
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

async function downloadDiagnostics(setDoctorLoading) {
  setDoctorLoading(true);
  try {
    const [doctor, logs, connectors] = await Promise.all([
      systemApi.getRuntimeDoctor(),
      systemApi.getRuntimeLogs(120),
      connectorsApi.getPiConnectorDiagnostics(),
    ]);
    const bundle = buildRuntimeDiagnosticsBundle({ connectors, doctor, logs });
    downloadText(`xuanwu-runtime-diagnostics-${safeTimestamp(bundle.generated_at)}.json`, formatRuntimeDiagnosticsBundle(bundle));
    message.success('脱敏诊断包已下载');
  } catch (err) {
    message.error(err.message || '生成诊断包失败');
  } finally {
    setDoctorLoading(false);
  }
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
    await action(await systemApi.getRuntimeDoctor());
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
    return <PanelLoader label="正在确认 Runtime 状态…" />;
  }
  if (!status) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>暂无状态数据</div>;
  }
  const rows = [
    ['API', status.service?.alive ? 'alive' : 'down', status.service?.alive],
    ['DB', status.db?.ok ? 'ok' : status.db?.error || 'error', status.db?.ok],
    ['Health reasons', `${status.health?.state || 'unknown'} · ${(status.health?.reasons || []).length} reasons`, status.health?.state === 'healthy'],
    ['Observability', `${status.observability?.dimensions?.work?.total || 0} Work / ${status.observability?.dimensions?.run?.total || 0} Run / ${status.observability?.cost?.usage?.total_tokens || 0} tokens`, true],
    ['Codex server', `${status.codex?.server_mode || 'cli'} · ${status.codex?.command || 'missing'}`, status.codex?.command_ok],
    ['Auth enabled', status.config?.auth_enabled ? 'enabled' : 'disabled', !status.config?.auth_enabled],
    ['Runner loops', `${status.runner?.running_loops || 0} running / ${status.runner?.in_progress_issues || 0} in progress / max ${status.runner?.max_parallel_projects || 1}`, true],
    ['Process-group memory', processGroupMemorySummary(status.process_group_memory), memoryBudgetOk(status.process_group_memory)],
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
      <ProcessGroupMemoryStatus memory={status.process_group_memory} />
    </div>
  );
}

function ProcessGroupMemoryStatus({ memory }) {
  if (!memory || memory.freshness?.status === 'unavailable') return null;
  const roles = Array.isArray(memory.roles) ? memory.roles : [];
  const top = Array.isArray(memory.top_by_rss) ? memory.top_by_rss.slice(0, 5) : [];
  return (
    <div style={{ border: '1px solid var(--border-light)', borderRadius: '14px', padding: '12px', background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <strong>Runner process-group memory</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
          sampled {formatMemorySampleTime(memory.sampled_at)} · {memory.freshness?.status || 'unknown'} · no auto-restart
        </span>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '8px' }}>
        Group footprint {formatMiB(memory.aggregate?.footprint_bytes)} · main heap {formatMiB(memory.main?.heap_used_bytes)} · external {formatMiB(memory.main?.external_bytes)} · array buffers {formatMiB(memory.main?.array_buffers_bytes)}
      </div>
      <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
        {roles.map(role => (
          <div key={role.role} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '0.82rem' }}>
            <span>{role.role} · {role.process_count || 0} PID</span>
            <strong>{formatMiB(role.rss_bytes)}</strong>
          </div>
        ))}
      </div>
      {top.length > 0 && (
        <div style={{ display: 'grid', gap: '6px', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border-light)' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Top PID by macOS ps RSS</span>
          {top.map(process => (
            <div key={`${process.pid}-${process.started_at}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '0.78rem' }}>
              <span>PID {process.pid} · {process.role} · {process.owner}</span>
              <strong>{formatMiB(process.rss_bytes)}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function processGroupMemorySummary(memory) {
  if (!memory || memory.freshness?.status === 'unavailable') return 'unavailable';
  return `${memory.phase || 'unknown'} · RSS ${formatMiB(memory.aggregate?.rss_bytes)} · P95 ${formatMiB(memory.aggregate?.rss_p95_bytes)} · ${memory.budget?.status || 'unknown'}`;
}

function memoryBudgetOk(memory) {
  return memory?.budget?.status === 'within_budget';
}

function formatMiB(bytes) {
  if (!Number.isFinite(Number(bytes))) return 'n/a';
  return `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatMemorySampleTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : 'unknown';
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
