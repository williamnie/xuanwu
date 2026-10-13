import { systemApi } from '../api/system.js';
import { connectorsApi } from '../api/connectors.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Download, RefreshCw } from 'lucide-react';
import { message } from '../store/toastStore';
import RuntimeLogsPanel from '../components/RuntimeLogsPanel';
import { PanelLoader } from '../components/TurtleLoader';
import { formatRuntimeLogsSummary } from '../utils/runtimeLogs';
import { buildRuntimeDiagnosticsBundle, formatRuntimeDiagnosticsBundle } from '../utils/runtimeDiagnostics';
import { APP_VERSION, buildVersionSummary } from '../version';
import SettingsTabContent from './AssistantSettingsSections';
import { SettingsHeader, SettingsNavigation, SettingsSectionIntro } from './SettingsChrome';
import { resolveSettingsRoute, settingsRouteId } from './settingsNavigation';
import './Settings.css';

export default function Settings({ initialTab = 'general', navigateTo, onSectionChange, pageTitle, theme, toggleTheme }) {
  const [route, setRoute] = useState(() => resolveSettingsRoute(initialTab));
  const contentRef = useRef(null);

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [route.tab]);

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
          <SettingsTabContent
            activeTab={route.tab}
            advancedSection={route.section}
            navigateTo={navigateTo}
            onAdvancedSectionChange={section => handleRouteChange({ tab: 'advanced', section })}
            RuntimeStatusPanel={RuntimeStatusPanel}
            theme={theme}
            toggleTheme={toggleTheme}
          />
        </section>
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
        <RuntimeHealthLine loading={loading} status={status} />
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
      {!error && <RuntimeStatusBody status={status} />}
      <details className="settings-disclosure runtime-status__logs">
        <summary><strong>运行日志</strong></summary>
        <div className="settings-disclosure-content">
          <RuntimeLogsPanel logs={logs} loading={logsLoading} error={logsError} onCopy={handleCopyLogs} />
        </div>
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

// 只保留一行健康摘要；10 项状态卡与进程组内存明细都在诊断包（/api/system/doctor）里，排查时下载即可。
function RuntimeHealthLine({ loading, status }) {
  if (loading && !status) return <PanelLoader label="正在确认服务状态…" />;
  if (!status) return <div className="runtime-status__empty">暂无状态数据</div>;
  const reasons = status.health?.reasons || [];
  const items = [
    ['API', status.service?.alive],
    ['数据库', status.db?.ok],
    ['编程工具', !reasons.some(reason => String(reason.code || '').startsWith('provider_'))],
  ];
  return (
    <ul className="runtime-status__health" aria-label="服务健康摘要">
      {items.map(([label, ok]) => (
        <li key={label}>
          <span className={`status-dot runtime-status__dot ${ok ? 'active' : 'idle'}`}></span>
          {label} <strong>{ok ? '正常' : '需检查'}</strong>
        </li>
      ))}
      <li>后台循环 <strong>{status.runner?.running_issues || 0} 个执行中 · 并发上限 {status.runner?.max_parallel_projects || 1}</strong></li>
    </ul>
  );
}

function RuntimeStatusBody({ status }) {
  if (!status) return null;
  const version = buildVersionSummary(APP_VERSION, status);
  const reasons = status.health?.reasons || [];
  return (
    <div className="runtime-status__body">
      {reasons.length ? <ul className="runtime-status__reasons">{reasons.map(reason => <li key={`${reason.code}:${reason.source_ref}`}>{reason.message || reason.code}</li>)}</ul> : null}
      <SecurityWarnings warnings={status.security?.warnings || []} />
      {version.ok ? null : <VersionSummaryCard summary={version} />}
    </div>
  );
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
