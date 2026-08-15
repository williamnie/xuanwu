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
import { resolveSettingsRoute, settingsRouteId } from './settingsNavigation';
import './Settings.css';

export default function Settings({ initialTab = 'general', navigateTo, onSectionChange, pageTitle }) {
  const [route, setRoute] = useState(() => resolveSettingsRoute(initialTab));

  useEffect(() => {
    setRoute(resolveSettingsRoute(initialTab));
  }, [initialTab]);

  const handleRouteChange = (nextRoute) => {
    setRoute(nextRoute);
    onSectionChange?.(settingsRouteId(nextRoute));
  };

  return (
    <div className="settings-page animate-fade-in">
      <SettingsHeader onRouteChange={handleRouteChange} route={route} title={pageTitle} />
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
    <section className="glass-card runtime-status">
      <div className="runtime-status__header">
        <div>
          <h2 className="runtime-status__heading">
            <ServerCog size={18} color="var(--primary)" /> Runtime Status
          </h2>
          <p className="runtime-status__description">
            只读状态检查，不启动新的 Codex 深度探针。
          </p>
        </div>
        <div className="runtime-status__actions">
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
      {error && <div className="runtime-status__error">{error}</div>}
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
    return <div className="runtime-status__empty">暂无状态数据</div>;
  }
  const rows = [
    ['API', status.service?.alive ? 'alive' : 'down', status.service?.alive],
    ['DB', status.db?.ok ? 'ok' : status.db?.error || 'error', status.db?.ok],
    ['Health reasons', `${status.health?.state || 'unknown'} · ${(status.health?.reasons || []).length} reasons`, status.health?.state === 'healthy'],
    ['Observability', `${status.observability?.dimensions?.work?.total || 0} Work / ${status.observability?.dimensions?.run?.total || 0} Run / ${status.observability?.cost?.usage?.total_tokens || 0} tokens`, true],
    ['Codex server', `${status.codex?.server_mode || 'cli'} · ${status.codex?.command || 'missing'}`, status.codex?.command_ok],
    ['Auth enabled', status.config?.auth_enabled ? 'enabled' : 'disabled', !status.config?.auth_enabled],
    ['Runner loops', `${status.runner?.running_loops || 0} running / ${status.runner?.in_progress_issues || 0} in progress / max ${status.runner?.max_parallel_projects || 1}`, true],
    ['PI project manager', managerModeSummary(status.pi_guardian?.runtime_modes), Number(status.pi_guardian?.runtime_modes?.manager_active_projects || 0) > 0],
    ['Guardian supervisor', supervisorModeSummary(status.pi_guardian?.runtime_modes), Number(status.pi_guardian?.runtime_modes?.supervisor_active_projects || 0) > 0],
    ['Process-group memory', processGroupMemorySummary(status.process_group_memory), memoryBudgetOk(status.process_group_memory)],
  ];
  return (
    <div className="runtime-status__body">
      <VersionSummaryCard summary={buildVersionSummary(APP_VERSION, status)} />
      <SecurityWarnings warnings={status.security?.warnings || []} />
      <div className="runtime-status__grid">
        {rows.map(([label, value, ok]) => (
          <div className="runtime-status__card" key={label}>
            <div className="runtime-status__card-label">{label}</div>
            <div className="runtime-status__card-value">
              <span className={`status-dot runtime-status__dot ${ok ? 'active' : 'idle'}`}></span>
              {value}
            </div>
          </div>
        ))}
      </div>
      <ProcessGroupMemoryStatus memory={status.process_group_memory} />
    </div>
  );
}

function managerModeSummary(modes) {
  const active = Number(modes?.manager_active_projects || 0);
  const disabled = Number(modes?.manager_disabled_projects || 0);
  return active > 0
    ? `${active} active / ${disabled} disabled`
    : `disabled · Guardian does not decompose or replan Work`;
}

function supervisorModeSummary(modes) {
  const active = Number(modes?.supervisor_active_projects || 0);
  return `${active} active · independent of project manager`;
}

function ProcessGroupMemoryStatus({ memory }) {
  if (!memory || memory.freshness?.status === 'unavailable') return null;
  const roles = Array.isArray(memory.roles) ? memory.roles : [];
  const top = Array.isArray(memory.top_by_rss) ? memory.top_by_rss.slice(0, 5) : [];
  const measurementSource = memory.budget?.measurement_source || memory.measurement?.source || 'unknown';
  const measuredGroup = memory.budget?.measured_group_bytes;
  const measuredMain = memory.budget?.measured_main_bytes;
  return (
    <div className="runtime-status__card">
      <div className="runtime-status__split-row">
        <strong>Runner process-group memory</strong>
        <span className="runtime-status__meta">
          sampled {formatMemorySampleTime(memory.sampled_at)} · {memory.freshness?.status || 'unknown'} · no auto-restart
        </span>
      </div>
      <div className="runtime-status__meta runtime-status__meta--spaced">
        Budget measurement {measurementSource} · group {formatMiB(measuredGroup)} · main {formatMiB(measuredMain)} · probe {memory.measurement?.physical_memory_probe || 'unknown'}
      </div>
      <div className="runtime-status__meta runtime-status__meta--compact">
        Activity {memory.activity?.status || 'unknown'} · issue runs {memory.activity?.issue_runs || 0} · Agentic in-flight {memory.activity?.agentic_in_flight || 0} · idle grace {formatDurationMs(memory.activity?.idle_grace_ms)}
      </div>
      <div className="runtime-status__meta runtime-status__meta--compact">
        Physical footprint {formatMiB(memory.aggregate?.footprint_bytes)} · RSS {formatMiB(memory.aggregate?.rss_bytes)} · RSS P95 {formatMiB(memory.aggregate?.rss_p95_bytes)} · main heap {formatMiB(memory.main?.heap_used_bytes)} · external {formatMiB(memory.main?.external_bytes)} · array buffers {formatMiB(memory.main?.array_buffers_bytes)}
      </div>
      <div className="runtime-status__role-list">
        {roles.map(role => (
          <div className="runtime-status__split-row runtime-status__role" key={role.role}>
            <span>{role.role} · {role.process_count || 0} PID</span>
            <strong>{formatMiB(role.rss_bytes)}</strong>
          </div>
        ))}
      </div>
      {top.length > 0 && (
        <div className="runtime-status__process-list">
          <span className="runtime-status__card-label">Top PID by macOS ps RSS</span>
          {top.map(process => (
            <div className="runtime-status__split-row runtime-status__process" key={`${process.pid}-${process.started_at}`}>
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
  const source = memory.budget?.measurement_source || memory.measurement?.source || 'unknown';
  return `${memory.phase || 'unknown'} · ${source} ${formatMiB(memory.budget?.measured_group_bytes)} · RSS P95 ${formatMiB(memory.aggregate?.rss_p95_bytes)} · ${memory.budget?.status || 'unknown'}`;
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

function formatDurationMs(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'n/a';
  return `${(milliseconds / 1000).toFixed(0)}s`;
}

function SecurityWarnings({ warnings }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div className="runtime-status__warning-card">
      <div className="runtime-status__title-row">
        <AlertTriangle size={16} color="var(--warning)" />
        安全诊断告警
      </div>
      <ul className="runtime-status__warning-list">
        {warnings.map(warning => (
          <li key={warning.code}>{warning.message || warning.code}</li>
        ))}
      </ul>
    </div>
  );
}

function VersionSummaryCard({ summary }) {
  return (
    <div className={`runtime-status__version ${summary.ok ? 'is-success' : 'is-warning'}`}>
      <div className="runtime-status__title-row">
        {!summary.ok && <AlertTriangle size={16} color="var(--warning)" />}
        版本摘要
      </div>
      <div className="runtime-status__version-summary">
        <span>Frontend: <strong>{summary.frontendVersion}</strong></span>
        <span>Backend: <strong>{summary.backendVersion}</strong></span>
        <span>Build stamp: <strong>{summary.distStampStatus}</strong></span>
      </div>
      {summary.buildStamp && (
        <div className="runtime-status__build-stamp">
          Runtime stamp: {summary.buildStamp}
        </div>
      )}
      <VersionWarnings warnings={summary.warnings} />
    </div>
  );
}

function VersionWarnings({ warnings }) {
  if (warnings.length === 0) {
    return <div className="runtime-status__version-ok">前后端版本与 build stamp 未发现明显 mismatch。</div>;
  }
  return (
    <ul className="runtime-status__version-warnings">
      {warnings.map(warning => <li key={warning}>{warning}</li>)}
    </ul>
  );
}
