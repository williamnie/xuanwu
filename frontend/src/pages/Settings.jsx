import { systemApi } from '../api/system.js';
import { connectorsApi } from '../api/connectors.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Download, RefreshCw } from 'lucide-react';
import { message } from '../store/toastStore';
import RuntimeLogsPanel from '../components/RuntimeLogsPanel';
import { PanelLoader } from '../components/TurtleLoader';
import { formatRuntimeLogsSummary } from '../utils/runtimeLogs';
import { buildRuntimeDiagnosticsBundle, formatRuntimeDiagnosticsBundle } from '../utils/runtimeDiagnostics';
import SettingsTabContent from './AssistantSettingsSections';
import { SettingsHeader, SettingsNavigation, SettingsSectionIntro } from './SettingsChrome';
import { resolveSettingsRoute, settingsRouteId } from './settingsNavigation';
import './Settings.css';

export default function Settings({ initialTab = 'general', navigateTo, onSectionChange, pageTitle, theme, toggleTheme }) {
  const [route, setRoute] = useState(() => resolveSettingsRoute(initialTab));
  const contentRef = useRef(null);

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    if (route.section) requestAnimationFrame(() => document.getElementById(`settings-${route.section}`)?.scrollIntoView({ block: 'start' }));
  }, [route.tab, route.section]);

  useEffect(() => {
    setRoute(resolveSettingsRoute(initialTab));
  }, [initialTab]);

  const handleRouteChange = (nextRoute) => {
    setRoute(nextRoute);
    onSectionChange?.(settingsRouteId(nextRoute));
  };

  return (
    <div className="settings-page">
      <SettingsHeader title={pageTitle} />
      <div className="settings-workspace">
        <SettingsNavigation onRouteChange={handleRouteChange} route={route} />
        <section className="settings-tab-content" aria-labelledby="settings-section-title" ref={contentRef}>
          <SettingsSectionIntro route={route} />
          <SettingsTabContent activeTab={route.tab} section={route.section} tier={route.tier} RuntimeStatusPanel={RuntimeStatusPanel} navigateTo={navigateTo} theme={theme} toggleTheme={toggleTheme} />
        </section>
      </div>
    </div>
  );
}

function RuntimeStatusPanel() {
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsVisited, setLogsVisited] = useState(false);
  const [error, setError] = useState('');
  const [logsError, setLogsError] = useState('');
  const [doctorLoading, setDoctorLoading] = useState(false);

  useEffect(() => {
    loadStatus(setStatus, setError, setLoading);
  }, []);

  const handleCopyDoctor = () => copyDoctor(setDoctorLoading);
  const handleDownloadDiagnostics = () => downloadDiagnostics(setDoctorLoading);
  const handleCopyLogs = () => copyLogs(logs);
  const handleRefresh = () => {
    loadStatus(setStatus, setError, setLoading);
    if (logsVisited) loadLogs(setLogs, setLogsError, setLogsLoading);
  };

  return (
    <section className="glass-card runtime-status">
      <div className="runtime-status__header">

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
      <details className="settings-disclosure" onToggle={event => { if (event.currentTarget.open && !logsVisited) { setLogsVisited(true); loadLogs(setLogs, setLogsError, setLogsLoading); } }}>
        <summary>运行日志</summary>{logsVisited && <RuntimeLogsPanel logs={logs} loading={logsLoading} error={logsError} onCopy={handleCopyLogs} />}
      </details>
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
    ['API', status.service?.alive ? '正常' : '异常'],
    ['数据库', status.db?.ok ? '正常' : status.db?.error || '异常'],
    ['编程工具', status.codex?.command_ok ? '就绪' : '需要检查'],
    ['后台循环', `${status.runner?.running_loops || 0} 个运行中`],
  ];
  return <div className="runtime-status__body"><SecurityWarnings warnings={status.security?.warnings || []} />
    <div className="runtime-status__health-line">{rows.map(([label, value]) => <span key={label}>{label}：{value}</span>)}</div>
  </div>;
}

function SecurityWarnings({ warnings }) {
  if (!warnings.length) return null;
  return <div className="runtime-status__warning-card" role="alert"><strong><AlertTriangle size={14} /> 安全诊断告警</strong><ul>{warnings.map(warning => <li key={warning.code}>{warning.message || warning.code}</li>)}</ul></div>;
}
